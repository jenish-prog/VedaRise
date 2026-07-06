import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleDecoder } from "google-news-url-decoder";

const googleDecoder = new GoogleDecoder();

type NewsItem = {
  title: string;
  source: string;
  url: string;
  summary: string;
  topic: "historical" | "academic";
  scrapedImgUrl?: string | null;
};

const AI_URL = "https://ai.gateway.lovable.dev/v1";

export async function runPipeline(supabase: SupabaseClient) {
  const apiKey = process.env.API_KEY || "";
  if (!apiKey) {
    console.warn("AI is not configured. Running pipeline with mock generations.");
  }

  const items = await fetchTrendingNews();
  const runDate = new Date().toISOString().slice(0, 10);

  // Clear any pending drafts for today so a re-run replaces them.
  await supabase.from("drafts").delete().eq("run_date", runDate).eq("status", "pending");

  const results: Array<{ ok: boolean; title: string; error?: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const scrapedImgUrl = await scrapeArticleImage(item.url);
      const [image, caption] = await Promise.all([
        generateImage(apiKey, { ...item, scrapedImgUrl }, i + 1),
        generateCaption(apiKey, item),
      ]);

      // Upload PNG/SVG to storage
      const isSvg = image.startsWith("<svg");
      const path = `${runDate}/${crypto.randomUUID()}.${isSvg ? "svg" : "png"}`;
      const bytes = isSvg 
        ? new TextEncoder().encode(image) 
        : Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
      const up = await supabase.storage.from("post-images").upload(path, bytes, {
        contentType: isSvg ? "image/svg+xml" : "image/png",
        upsert: true,
      });
      if (up.error) throw up.error;

      const { data: signed } = await supabase.storage.from("post-images").createSignedUrl(path, 60 * 60 * 24 * 30);

      const { error } = await supabase.from("drafts").insert({
        run_date: runDate,
        rank: i + 1,
        title: item.title,
        source: item.source,
        url: item.url,
        summary: item.summary,
        topic: item.topic,
        image_path: path,
        image_url: signed?.signedUrl ?? null,
        caption: caption.caption,
        hashtags: caption.hashtags,
      });
      if (error) throw error;
      results.push({ ok: true, title: item.title });
    } catch (err) {
      results.push({ ok: false, title: item.title, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { runDate, count: results.filter((r) => r.ok).length, results };
}

async function fetchTrendingNews(): Promise<NewsItem[]> {
  // Free news source: Google News RSS. No API key required.
  // Two queries — one for historical/ancient manuscripts, one for academic manuscripts —
  // then merge, dedupe, and let AI pick the top 5 trending.
  const queries: Array<{ q: string; topic: "historical" | "academic" }> = [
    { q: '"manuscript" OR "manuscripts" (ancient OR medieval OR discovered OR auction OR digitization)', topic: "historical" },
    { q: '"manuscript" (journal OR preprint OR "peer review" OR retraction OR submission)', topic: "academic" },
  ];

  const raw: Array<{ title: string; source: string; url: string; summary: string; topic: "historical" | "academic"; pubDate: string }> = [];
  for (const { q, topic } of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ManuscriptsDaily/1.0" } });
    if (!res.ok) continue;
    const xml = await res.text();
    raw.push(...parseRss(xml).map((i) => ({ ...i, topic })));
  }

  if (raw.length === 0) throw new Error("No news items found from Google News right now.");

  // Dedupe by title (case-insensitive first 60 chars)
  const seen = new Set<string>();
  const deduped = raw.filter((i) => {
    const k = i.title.slice(0, 60).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // If we already have enough, take the 5 most recent per pubDate as fallback.
  deduped.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  const shortlist = deduped.slice(0, 20);

  // Ask AI to pick top 5 trending
  const apiKey = process.env.API_KEY;
  if (!apiKey) return shortlist.slice(0, 5);

  try {
    const r = await fetch(`${AI_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content:
              "You rank news items about manuscripts. Given a list of candidates from the last 24h, return the top 5 most trending/impactful. Balance historical and academic topics. For each, write a punchy 1-2 sentence summary (do not copy the headline). Return strict JSON: {\"items\":[{\"index\":number,\"summary\":string}]}. `index` is the 0-based position in the input list.",
          },
          {
            role: "user",
            content: JSON.stringify(shortlist.map((i, idx) => ({ index: idx, title: i.title, source: i.source, topic: i.topic }))),
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (r.ok) {
      const j = (await r.json()) as { choices: Array<{ message: { content: string } }> };
      const picks = JSON.parse(j.choices[0].message.content) as { items: Array<{ index: number; summary: string }> };
      const chosen: NewsItem[] = [];
      for (const p of picks.items.slice(0, 5)) {
        const item = shortlist[p.index];
        if (item) chosen.push({ title: item.title, source: item.source, url: item.url, summary: p.summary, topic: item.topic });
      }
      if (chosen.length > 0) return chosen;
    }
  } catch {
    // fall through
  }

  return shortlist.slice(0, 5).map((i) => ({ title: i.title, source: i.source, url: i.url, summary: i.title, topic: i.topic }));
}

function parseRss(xml: string): Array<{ title: string; source: string; url: string; summary: string; pubDate: string }> {
  const items: Array<{ title: string; source: string; url: string; summary: string; pubDate: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = decode(pick(block, "title"));
    const link = decode(pick(block, "link"));
    const pubDate = pick(block, "pubDate");
    const source = decode(pick(block, "source")) || new URL(link || "https://news.google.com").hostname;
    const description = decode(pick(block, "description")).replace(/<[^>]+>/g, "").trim();
    if (title && link) items.push({ title, url: link, source, summary: description, pubDate });
  }
  return items;
}

function pick(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : "";
}

function decode(s: string): string {
  return s
    .replace(/&amp;nbsp;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

async function generateImage(key: string, item: NewsItem, rank?: number): Promise<string> {
  if (!key) {
    return generateSvgImage(item, rank || 1);
  }
  const prompt = buildImagePrompt(item);
  const res = await fetch(`${AI_URL}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-image-2",
      prompt,
      size: "1024x1024",
      quality: "medium",
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`Image gen ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: Array<{ b64_json: string }> };
  return json.data[0].b64_json;
}

// Editorial poster template inspired by Project Veda: warm dark brown background,
// aged manuscript pages, dramatic gold-lit letterforms hinting at the topic, elegant
// serif headline overlay, thin ornamental gold divider, subtle caption line at bottom.
function buildImagePrompt(item: NewsItem): string {
  const shortHeadline = item.title.length > 90 ? item.title.slice(0, 90) + "…" : item.title;
  return [
    "Editorial social media poster, exactly 1080x1080 square, portrait-safe composition.",
    "Background: rich warm dark brown and deep sepia gradient, subtle vignette, softly lit aged palm-leaf or paper manuscript pages with faint script visible as texture (no readable body text).",
    "Top center: small refined serif eyebrow label reading 'MANUSCRIPTS DAILY' in muted cream, wide letter-spacing.",
    "Center focal element: an elegant gold-illuminated ornamental motif or a single large gilded serif letterform (do not spell full words), evoking ancient manuscripts.",
    `Lower half: crisp elegant serif headline in warm cream (#F1E4C6), 2-3 lines, centered, reading exactly: "${shortHeadline}"`,
    "Below headline: a thin ornate gold horizontal divider with a small central flourish.",
    "Bottom: a single line of small muted cream sans-serif text reading 'A daily brief on manuscripts across the world.'",
    "Style: cinematic, museum-editorial, warm candle-lit gold and brown palette, high contrast, tasteful, no logos, no watermarks, no gibberish text — headline text must render clearly and correctly.",
    `Topic accent: ${item.topic === "historical" ? "ancient/heritage feel, palm leaf, gold leaf" : "academic/scholarly feel, journal pages, quiet library"}.`,
  ].join(" ");
}

async function generateCaption(
  key: string,
  item: NewsItem,
): Promise<{ caption: string; hashtags: string[] }> {
  if (!key) {
    return {
      caption: `Interesting manuscript update: ${item.summary || item.title}`,
      hashtags: [item.topic, "manuscripts", "history", "scholarly"]
    };
  }
  const res = await fetch(`${AI_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "system",
          content:
            "You write engaging social captions for a global audience interested in manuscripts (historical and academic). Keep captions under 220 characters. Return 6-10 relevant hashtags. Return strict JSON {\"caption\":string,\"hashtags\":string[]}. Hashtags without # prefix.",
        },
        {
          role: "user",
          content: `Headline: ${item.title}\nSource: ${item.source}\nTopic: ${item.topic}\nSummary: ${item.summary}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`Caption gen ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(json.choices[0].message.content) as { caption: string; hashtags: string[] };
  return {
    caption: parsed.caption ?? "",
    hashtags: (parsed.hashtags ?? []).map((h) => h.replace(/^#/, "")),
  };
}

function generateSvgImage(item: NewsItem, rank: number): string {
  const hasImage = !!item.scrapedImgUrl;
  const firstLetter = item.title.trim().charAt(0).toUpperCase() || "M";
  
  const headlineStartY = hasImage ? 685 : 550;
  const headlineLineHeight = 52;
  const maxHeadlineLines = hasImage ? 2 : 3;
  const headlineLines = wrapText(item.title, 35).slice(0, maxHeadlineLines);
  
  const dividerY = hasImage ? 805 : 710;
  
  const captionStartY = hasImage ? 850 : 770;
  const captionLineHeight = 28;
  const maxCaptionLines = hasImage ? 2 : 3;
  const captionLines = wrapText(item.summary || item.title, 55).slice(0, maxCaptionLines);

  const width = 1080;
  const height = 1080;

  const styleIndex = (rank - 1) % 4;

  let bgGrad = "";
  let titleColor = "";
  let eyebrowColor = "";
  let subtitleColor = "";
  let captionColor = "";
  let accentColor = "";
  let eyebrowText = "PROJECT VEDA";
  let middleImageBg = "";
  let dividerStyle = "standard";

  if (styleIndex === 0) {
    bgGrad = `
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="70%" fx="50%" fy="50%">
      <stop offset="0%" stop-color="#FCF8F2" />
      <stop offset="60%" stop-color="#F2E6D5" />
      <stop offset="100%" stop-color="#D7C3A9" />
    </radialGradient>
    `;
    titleColor = "#3D2612";
    eyebrowColor = "#5C3E26";
    subtitleColor = "#8A674D";
    captionColor = "#4F3520";
    accentColor = "#8A674D";
    middleImageBg = "#EADA9E";
    dividerStyle = "parchment";
  } else if (styleIndex === 1) {
    bgGrad = `
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="70%" fx="50%" fy="50%">
      <stop offset="0%" stop-color="#1A1A24" />
      <stop offset="100%" stop-color="#0A0A0F" />
    </radialGradient>
    `;
    titleColor = "#FFFFFF";
    eyebrowColor = "#818CF8";
    subtitleColor = "#6366F1";
    captionColor = "#C7D2FE";
    accentColor = "#818CF8";
    middleImageBg = "#111118";
    dividerStyle = "neonoir";
    eyebrowText = "MANUSCRIPTS DAILY";
  } else if (styleIndex === 2) {
    bgGrad = `
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="70%" fx="50%" fy="50%">
      <stop offset="0%" stop-color="#0F382E" />
      <stop offset="100%" stop-color="#03120E" />
    </radialGradient>
    `;
    titleColor = "#F5EFEB";
    eyebrowColor = "#C5A880";
    subtitleColor = "#A29B8E";
    captionColor = "#DFD9D0";
    accentColor = "#C5A880";
    middleImageBg = "#051A15";
    dividerStyle = "emerald";
  } else {
    bgGrad = `
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="70%" fx="50%" fy="50%">
      <stop offset="0%" stop-color="#460D12" />
      <stop offset="100%" stop-color="#140204" />
    </radialGradient>
    `;
    titleColor = "#FCEEE3";
    eyebrowColor = "#E5A99E";
    subtitleColor = "#B88F88";
    captionColor = "#EADAD2";
    accentColor = "#E5A99E";
    middleImageBg = "#1E0406";
    dividerStyle = "crimson";
  }

  const headlineSvg = headlineLines.map((line, idx) => 
    `<text x="540" y="${headlineStartY + idx * headlineLineHeight}" text-anchor="middle" font-family="'Playfair Display', 'Georgia', serif" font-size="38" font-weight="bold" fill="${titleColor}">${escapeXml(line)}</text>`
  ).join("\n");

  const captionSvg = captionLines.map((line, idx) => 
    `<text x="540" y="${captionStartY + idx * captionLineHeight}" text-anchor="middle" font-family="'Inter', 'sans-serif'" font-size="19" fill="${captionColor}" opacity="0.95">${escapeXml(line)}</text>`
  ).join("\n");

  let middleContent = "";
  if (hasImage) {
    middleContent = `
  <!-- Scraped Article Image Card -->
  <rect x="178" y="188" width="724" height="434" fill="none" stroke="url(#goldGrad)" stroke-width="3" rx="8" />
  <rect x="180" y="190" width="720" height="430" fill="${middleImageBg}" rx="6" />
  <image href="${escapeXml(item.scrapedImgUrl!)}" x="180" y="190" width="720" height="430" preserveAspectRatio="xMidYMid slice" rx="6" />
    `;
  } else {
    middleContent = `
  <!-- Giant Gilded Starting Letter -->
  <circle cx="540" cy="330" r="150" fill="none" stroke="${accentColor}" stroke-width="1" opacity="0.25" />
  <circle cx="540" cy="330" r="140" fill="none" stroke="${accentColor}" stroke-width="0.5" stroke-dasharray="5,5" opacity="0.3" />
  <text x="540" y="415" text-anchor="middle" font-family="'Playfair Display', 'Georgia', serif" font-size="260" font-weight="bold" fill="url(#goldGrad)">${escapeXml(firstLetter)}</text>
    `;
  }

  let dividerSvg = "";
  if (dividerStyle === "neonoir") {
    dividerSvg = `
  <line x1="390" y1="${dividerY}" x2="690" y2="${dividerY}" stroke="${accentColor}" stroke-width="1.5" opacity="0.8" />
  <circle cx="540" cy="${dividerY}" r="5" fill="${accentColor}" />
    `;
  } else if (dividerStyle === "emerald") {
    dividerSvg = `
  <line x1="390" y1="${dividerY}" x2="510" y2="${dividerY}" stroke="${accentColor}" stroke-width="1.5" opacity="0.7" />
  <line x1="570" y1="${dividerY}" x2="690" y2="${dividerY}" stroke="${accentColor}" stroke-width="1.5" opacity="0.7" />
  <polygon points="540,${dividerY - 6} 546,${dividerY} 540,${dividerY + 6} 534,${dividerY}" fill="${accentColor}" />
  <polygon points="520,${dividerY - 4} 524,${dividerY} 520,${dividerY + 4} 516,${dividerY}" fill="${accentColor}" />
  <polygon points="560,${dividerY - 4} 564,${dividerY} 560,${dividerY + 4} 556,${dividerY}" fill="${accentColor}" />
    `;
  } else if (dividerStyle === "crimson") {
    dividerSvg = `
  <line x1="390" y1="${dividerY - 2}" x2="690" y2="${dividerY - 2}" stroke="${accentColor}" stroke-width="1" opacity="0.6" />
  <line x1="390" y1="${dividerY + 2}" x2="690" y2="${dividerY + 2}" stroke="${accentColor}" stroke-width="1" opacity="0.6" />
  <circle cx="540" cy="${dividerY}" r="4" fill="${accentColor}" />
    `;
  } else {
    dividerSvg = `
  <line x1="390" y1="${dividerY}" x2="510" y2="${dividerY}" stroke="${accentColor}" stroke-width="1.5" opacity="0.6" />
  <line x1="570" y1="${dividerY}" x2="690" y2="${dividerY}" stroke="${accentColor}" stroke-width="1.5" opacity="0.6" />
  <polygon points="540,${dividerY - 5} 545,${dividerY} 540,${dividerY + 5} 535,${dividerY}" fill="${accentColor}" />
  <circle cx="525" cy="${dividerY}" r="3" fill="${accentColor}" />
  <circle cx="555" cy="${dividerY}" r="3" fill="${accentColor}" />
    `;
  }

  const bottomLogoColor = (styleIndex === 0 || styleIndex === 2 || styleIndex === 3) 
    ? "url(#goldGrad)" 
    : accentColor;

  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${bgGrad}

    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFEFA6" />
      <stop offset="30%" stop-color="#D4AF37" />
      <stop offset="70%" stop-color="#AA7C11" />
      <stop offset="100%" stop-color="#FFEFA6" />
    </linearGradient>
    
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&amp;family=Inter:wght@400;600&amp;family=Playfair+Display:ital,wght@0,600;1,400&amp;display=swap');
    </style>
  </defs>

  <rect width="100%" height="100%" fill="url(#bgGrad)" />

  <text x="540" y="110" text-anchor="middle" font-family="'Cinzel', 'Georgia', serif" font-size="24" font-weight="700" letter-spacing="8" fill="${eyebrowColor}">${eyebrowText}</text>
  <text x="540" y="145" text-anchor="middle" font-family="'Inter', 'sans-serif'" font-size="14" font-weight="600" letter-spacing="4" fill="${subtitleColor}">Preserve. Digitize. Empower.</text>

  ${middleContent}

  ${headlineSvg}

  ${dividerSvg}

  ${captionSvg}

  <g transform="translate(365, 940)">
    <circle cx="25" cy="25" r="25" fill="none" stroke="${bottomLogoColor}" stroke-width="2" />
    <path d="M 25,12 C 17.8,12 12,17.8 12,25 C 12,32.2 17.8,38 25,38 C 32.2,38 38,32.2 38,25 C 38,17.8 32.2,12 25,12 Z M 25,15 C 29.4,15 33,18.6 33,23 C 33,25.2 32.1,27.2 30.6,28.6 L 28.5,26.5 C 29.4,25.7 30,24.4 30,23 C 30,20.2 27.8,18 25,18 C 22.2,18 20,20.2 20,23 C 20,24.4 20.6,25.7 21.5,26.5 L 19.4,28.6 C 17.9,27.2 17,25.2 17,23 C 17,18.6 20.6,15 25,15 Z" fill="${bottomLogoColor}" />
    <circle cx="25" cy="23" r="3" fill="${bottomLogoColor}" />
    <circle cx="21" cy="28" r="2" fill="${bottomLogoColor}" />
    <circle cx="29" cy="28" r="2" fill="${bottomLogoColor}" />
    <line x1="25" y1="23" x2="21" y2="28" stroke="${bottomLogoColor}" stroke-width="1.5" />
    <line x1="25" y1="23" x2="29" y2="28" stroke="${bottomLogoColor}" stroke-width="1.5" />

    <text x="65" y="24" font-family="'Cinzel', 'Georgia', serif" font-size="20" font-weight="700" fill="${bottomLogoColor}" letter-spacing="1">VISHVENA TECHNO SOLUTIONS</text>
    <text x="65" y="44" font-family="'Inter', 'sans-serif'" font-size="11" font-weight="600" fill="${subtitleColor}" letter-spacing="4">WE BUILD</text>
  </g>
</svg>
  `.trim();
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length <= maxChars) {
      currentLine = (currentLine + " " + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case "\"": return "&quot;";
      default: return c;
    }
  });
}

async function fetchImageAsBase64(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "image/png";
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch (e) {
    console.warn("Failed to fetch image as base64:", imageUrl, e);
  }
  return null;
}

async function scrapeArticleImage(url: string): Promise<string | null> {
  try {
    let targetUrl = url;
    
    if (url.includes("news.google.com")) {
      const decoded = await googleDecoder.decode(url);
      if (decoded.status && decoded.decoded_url) {
        targetUrl = decoded.decoded_url;
      }
    }

    const res = await fetch(targetUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    
    const ogImageMatch = html.match(/<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                         html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image["']/i);
    if (ogImageMatch && ogImageMatch[1]) {
      const imgUrl = ogImageMatch[1].trim();
      const base64 = await fetchImageAsBase64(imgUrl);
      if (base64) return base64;
    }
    
    const imgMatch = html.match(/<img\s+[^>]*src=["'](https?:\/\/[^"']+\.(?:png|jpg|jpeg|webp))["']/i);
    if (imgMatch && imgMatch[1]) {
      const imgUrl = imgMatch[1].trim();
      const base64 = await fetchImageAsBase64(imgUrl);
      if (base64) return base64;
    }
  } catch (e) {
    console.warn("Failed to scrape image for URL:", url, e);
  }
  return null;
}