import crypto from "crypto";

type Channel = "linkedin" | "x" | "facebook" | "instagram" | "website";

export async function postDraft(draftId: string, overrideChannels?: Record<string, boolean>) {
  const { mysqlQuery } = await import("@/integrations/mysql/client.server");
  const drafts = await mysqlQuery<any[]>("SELECT * FROM drafts WHERE id = ?", [draftId]);
  const draft = drafts[0];
  if (!draft) throw new Error("Draft not found");

  let channels = (overrideChannels || draft.channels) as Record<string, boolean>;
  const results: Array<{ channel: Channel; ok: boolean; url?: string; error?: string }> = [];

  const allChannels: Channel[] = ["linkedin", "x", "facebook", "instagram", "website"];
  for (const ch of allChannels) {
    if (!channels?.[ch]) continue;
    try {
      const url = await postToChannel(ch, draft);
      results.push({ channel: ch, ok: true, url });
      await mysqlQuery(
        "INSERT INTO post_results (id, draft_id, channel, status, posted_url, error) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), draftId, ch, "success", url, null]
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ channel: ch, ok: false, error: msg });
      await mysqlQuery(
        "INSERT INTO post_results (id, draft_id, channel, status, posted_url, error) VALUES (?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), draftId, ch, "failed", null, msg]
      );
    }
  }

  const anyOk = results.some((r) => r.ok);
  const allOk = results.length > 0 && results.every((r) => r.ok);
  await mysqlQuery(
    "UPDATE drafts SET status = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?",
    [allOk ? "posted" : anyOk ? "posted" : "failed", draftId]
  );

  return { results };
}

async function postToChannel(
  channel: Channel,
  draft: any,
): Promise<string> {
  const body =
    `${draft.caption ?? ""}\n\n${(draft.hashtags ?? []).map((h: string) => `#${h}`).join(" ")}${draft.url ? `\n\n${draft.url}` : ""}`.trim();

  if (channel === "linkedin") return postLinkedIn(body);
  if (channel === "x") return postX(body);
  if (channel === "facebook") return postFacebook(body, draft.image_url);
  if (channel === "instagram") return postInstagram(body, draft.image_url);
  if (channel === "website") return postWebsite(draft);
  throw new Error(`Unknown channel ${channel}`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured. Connect it or add the secret.`);
  return v;
}

// ---- LinkedIn (via connector) ----
async function postLinkedIn(text: string): Promise<string> {
  const apiKey = requireEnv("API_KEY");
  const linkedinKey = requireEnv("LINKEDIN_API_KEY");

  const me = await fetch("https://connector-gateway.lovable.dev/linkedin/v2/userinfo", {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Connection-Api-Key": linkedinKey },
  });
  if (!me.ok) throw new Error(`LinkedIn userinfo failed: ${me.status}`);
  const { sub } = (await me.json()) as { sub: string };

  const res = await fetch("https://connector-gateway.lovable.dev/linkedin/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Connection-Api-Key": linkedinKey,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: `urn:li:person:${sub}`,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn post failed: ${res.status} ${await res.text()}`);
  const id = res.headers.get("x-restli-id") ?? "";
  return id ? `https://www.linkedin.com/feed/update/${id}` : "posted";
}

// ---- X (Twitter API v2) ----
async function postX(text: string): Promise<string> {
  const bearer = requireEnv("X_BEARER_TOKEN");
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 280) }),
  });
  if (!res.ok) throw new Error(`X post failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { data: { id: string } };
  return `https://x.com/i/status/${j.data.id}`;
}

// ---- Facebook Page (Graph API) ----
async function postFacebook(text: string, imageUrl: string | null): Promise<string> {
  const pageId = requireEnv("FACEBOOK_PAGE_ID");
  const token = requireEnv("FACEBOOK_PAGE_TOKEN");
  const endpoint = imageUrl
    ? `https://graph.facebook.com/v20.0/${pageId}/photos`
    : `https://graph.facebook.com/v20.0/${pageId}/feed`;
  const body: Record<string, string> = { access_token: token };
  if (imageUrl) {
    body.url = imageUrl;
    body.caption = text;
  } else {
    body.message = text;
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`Facebook post failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { id?: string; post_id?: string };
  const id = j.post_id ?? j.id ?? "";
  return `https://facebook.com/${id}`;
}

// ---- Instagram (Graph API, Business account) ----
async function postInstagram(text: string, imageUrl: string | null): Promise<string> {
  if (!imageUrl) throw new Error("Instagram requires an image URL.");
  const igId = requireEnv("INSTAGRAM_BUSINESS_ID");
  const token = requireEnv("FACEBOOK_PAGE_TOKEN");

  const container = await fetch(`https://graph.facebook.com/v20.0/${igId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      image_url: imageUrl,
      caption: text,
      access_token: token,
    }).toString(),
  });
  if (!container.ok)
    throw new Error(`IG container failed: ${container.status} ${await container.text()}`);
  const { id: creationId } = (await container.json()) as { id: string };

  const publish = await fetch(`https://graph.facebook.com/v20.0/${igId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: creationId, access_token: token }).toString(),
  });
  if (!publish.ok) throw new Error(`IG publish failed: ${publish.status} ${await publish.text()}`);
  const { id } = (await publish.json()) as { id: string };
  return `https://www.instagram.com/p/${id}`;
}

async function postWebsite(draft: { title: string }): Promise<string> {
  // Simulate posting to website CMS
  await new Promise((r) => setTimeout(r, 1000));
  return `https://veda-website.com/posts/${slugify(draft.title)}`;
}

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
