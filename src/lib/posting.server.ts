import type { SupabaseClient } from "@supabase/supabase-js";

type Channel = "linkedin" | "x" | "facebook" | "instagram";

export async function postDraft(supabase: SupabaseClient, draftId: string) {
  const { data: draft, error } = await supabase.from("drafts").select("*").eq("id", draftId).single();
  if (error || !draft) throw new Error(error?.message ?? "Draft not found");

  const channels = draft.channels as Record<Channel, boolean>;
  const results: Array<{ channel: Channel; ok: boolean; url?: string; error?: string }> = [];

  for (const ch of ["linkedin", "x", "facebook", "instagram"] as Channel[]) {
    if (!channels?.[ch]) continue;
    try {
      const url = await postToChannel(ch, draft);
      results.push({ channel: ch, ok: true, url });
      await supabase.from("post_results").insert({
        draft_id: draftId,
        channel: ch,
        status: "success",
        posted_url: url,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ channel: ch, ok: false, error: msg });
      await supabase.from("post_results").insert({
        draft_id: draftId,
        channel: ch,
        status: "failed",
        error: msg,
      });
    }
  }

  const anyOk = results.some((r) => r.ok);
  const allOk = results.length > 0 && results.every((r) => r.ok);
  await supabase
    .from("drafts")
    .update({
      status: allOk ? "posted" : anyOk ? "posted" : "failed",
      approved_at: new Date().toISOString(),
    })
    .eq("id", draftId);

  return { results };
}

async function postToChannel(
  channel: Channel,
  draft: { caption: string; hashtags: string[]; image_url: string | null; url: string | null },
): Promise<string> {
  const body = `${draft.caption ?? ""}\n\n${(draft.hashtags ?? []).map((h) => `#${h}`).join(" ")}${draft.url ? `\n\n${draft.url}` : ""}`.trim();

  if (channel === "linkedin") return postLinkedIn(body);
  if (channel === "x") return postX(body);
  if (channel === "facebook") return postFacebook(body, draft.image_url);
  if (channel === "instagram") return postInstagram(body, draft.image_url);
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

  const container = await fetch(
    `https://graph.facebook.com/v20.0/${igId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ image_url: imageUrl, caption: text, access_token: token }).toString(),
    },
  );
  if (!container.ok) throw new Error(`IG container failed: ${container.status} ${await container.text()}`);
  const { id: creationId } = (await container.json()) as { id: string };

  const publish = await fetch(
    `https://graph.facebook.com/v20.0/${igId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: creationId, access_token: token }).toString(),
    },
  );
  if (!publish.ok) throw new Error(`IG publish failed: ${publish.status} ${await publish.text()}`);
  const { id } = (await publish.json()) as { id: string };
  return `https://www.instagram.com/p/${id}`;
}