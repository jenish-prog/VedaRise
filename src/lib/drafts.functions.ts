import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { TablesUpdate } from "@/integrations/supabase/types";

export const listDrafts = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ runDate: z.string().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const date = data.runDate ?? new Date().toISOString().slice(0, 10);
    const { data: drafts, error } = await supabaseAdmin
      .from("drafts")
      .select("*, post_results(*)")
      .eq("run_date", date)
      .order("rank", { ascending: true });
    if (error) throw new Error(error.message);

    // Refresh signed image URLs (30-day)
    for (const d of drafts ?? []) {
      if (d.image_path) {
        const { data: signed } = await supabaseAdmin.storage
          .from("post-images")
          .createSignedUrl(d.image_path, 60 * 60 * 24 * 30);
        if (signed?.signedUrl) d.image_url = signed.signedUrl;
      }
    }
    return { runDate: date, drafts: drafts ?? [] };
  });

export const updateDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: TablesUpdate<"drafts"> = {};
    if (data.caption !== undefined) patch.caption = data.caption;
    if (data.hashtags !== undefined) patch.hashtags = data.hashtags;
    if (data.channels !== undefined) patch.channels = data.channels;
    const { error } = await supabaseAdmin.from("drafts").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const rejectDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("drafts")
      .update({ status: "rejected" })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const approveAndPost = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { postDraft } = await import("./posting.server");
    return postDraft(supabaseAdmin, data.id);
  });