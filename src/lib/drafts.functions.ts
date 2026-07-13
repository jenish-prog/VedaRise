import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { GoogleDecoder } from "google-news-url-decoder";

export const listDrafts = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ runDate: z.string().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { mysqlQuery } = await import("@/integrations/mysql/client.server");
    const date = data.runDate ?? new Date().toISOString().slice(0, 10);
    
    const drafts = await mysqlQuery<any[]>(
      "SELECT * FROM drafts WHERE run_date = ? ORDER BY `rank` ASC",
      [date]
    );

    if (drafts.length > 0) {
      const draftIds = drafts.map((d) => d.id);
      const placeholders = draftIds.map(() => "?").join(",");
      const results = await mysqlQuery<any[]>(
        `SELECT * FROM post_results WHERE draft_id IN (${placeholders})`,
        draftIds
      );

      for (const d of drafts) {
        d.post_results = results.filter((r) => r.draft_id === d.id);
      }
    }

    return { runDate: date, drafts: drafts ?? [] };
  });

export const updateDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().max(300).optional(),
        summary: z.string().max(3000).optional(),
        caption: z.string().max(2000).optional(),
        hashtags: z.array(z.string()).max(30).optional(),
        channels: z
          .object({
            linkedin: z.boolean().optional(),
            x: z.boolean().optional(),
            facebook: z.boolean().optional(),
            instagram: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { mysqlQuery } = await import("@/integrations/mysql/client.server");
    const fields: string[] = [];
    const params: any[] = [];

    if (data.title !== undefined) {
      fields.push("title = ?");
      params.push(data.title);
    }
    if (data.summary !== undefined) {
      fields.push("summary = ?");
      params.push(data.summary);
    }
    if (data.caption !== undefined) {
      fields.push("caption = ?");
      params.push(data.caption);
    }
    if (data.hashtags !== undefined) {
      fields.push("hashtags = ?");
      params.push(JSON.stringify(data.hashtags));
    }
    if (data.channels !== undefined) {
      fields.push("channels = ?");
      params.push(JSON.stringify(data.channels));
    }

    if (fields.length > 0) {
      fields.push("updated_at = NOW()");
      params.push(data.id);
      await mysqlQuery(
        `UPDATE drafts SET ${fields.join(", ")} WHERE id = ?`,
        params
      );
    }

    return { ok: true };
  });

export const rejectDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { mysqlQuery } = await import("@/integrations/mysql/client.server");
    await mysqlQuery(
      "UPDATE drafts SET status = 'rejected', updated_at = NOW() WHERE id = ?",
      [data.id]
    );
    return { ok: true };
  });

export const approveAndPost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        channels: z.record(z.boolean()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { postDraft } = await import("./posting.server");
    return postDraft(data.id, data.channels);
  });

export const regenerateDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { regenerateSingleDraft } = await import("./pipeline.server");
    return regenerateSingleDraft(data.id);
  });

export const regenerateImageDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { regenerateSingleImage } = await import("./pipeline.server");
    return regenerateSingleImage(data.id);
  });

export const regenerateCaptionDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { regenerateSingleCaption } = await import("./pipeline.server");
    return regenerateSingleCaption(data.id);
  });

export const regenerateHashtagsDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { regenerateSingleHashtags } = await import("./pipeline.server");
    return regenerateSingleHashtags(data.id);
  });

export const getArticleContent = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ url: z.string().url() }).parse(input))
  .handler(async ({ data }) => {
    try {
      let targetUrl = data.url;
      if (data.url.includes("news.google.com")) {
        const decoder = new GoogleDecoder();
        const decoded = await decoder.decode(data.url);
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
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) {
        throw new Error(`Server returned status: ${res.status}`);
      }
      const html = await res.text();

      // Clean HTML
      let cleaned = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");

      const paragraphs: string[] = [];
      const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      let match;
      while ((match = pRegex.exec(cleaned)) !== null) {
        const pText = match[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        
        if (pText.length > 60) {
          paragraphs.push(pText);
        }
      }

      if (paragraphs.length > 0) {
        return { content: paragraphs.join("\n\n") };
      }

      // Fallback
      const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyContent = bodyMatch ? bodyMatch[1] : cleaned;
      const plainText = bodyContent
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim();

      if (plainText.length > 0) {
        return { content: plainText.slice(0, 1500) + "..." };
      }

      throw new Error("Could not extract any readable content from this article.");
    } catch (e) {
      console.error("Failed to scrape article:", data.url, e);
      throw new Error(e instanceof Error ? e.message : "Failed to retrieve article content");
    }
  });
