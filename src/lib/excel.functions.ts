import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const exportDraftsXlsx = createServerFn({ method: "POST" })
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

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Manuscripts ${date}`);
    ws.columns = [
      { header: "Rank", key: "rank", width: 6 },
      { header: "Title", key: "title", width: 40 },
      { header: "Source", key: "source", width: 18 },
      { header: "URL", key: "url", width: 40 },
      { header: "Topic", key: "topic", width: 12 },
      { header: "Summary", key: "summary", width: 50 },
      { header: "Image URL", key: "image_url", width: 40 },
      { header: "Caption", key: "caption", width: 50 },
      { header: "Hashtags", key: "hashtags", width: 30 },
      { header: "Status", key: "status", width: 12 },
      { header: "Posted URLs", key: "posted", width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const d of drafts ?? []) {
      const posted = (
        (d.post_results ?? []) as Array<{ channel: string; posted_url: string | null }>
      )
        .map((p) => `${p.channel}: ${p.posted_url ?? "-"}`)
        .join("\n");
      ws.addRow({
        rank: d.rank,
        title: d.title,
        source: d.source,
        url: d.url,
        topic: d.topic,
        summary: d.summary,
        image_url: d.image_url,
        caption: d.caption,
        hashtags: (d.hashtags ?? []).map((h: string) => `#${h}`).join(" "),
        status: d.status,
        posted,
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    const b64 = Buffer.from(buf).toString("base64");
    return { filename: `manuscripts-${date}.xlsx`, base64: b64 };
  });
