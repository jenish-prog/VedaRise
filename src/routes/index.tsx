import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listDrafts, updateDraft, rejectDraft, approveAndPost } from "@/lib/drafts.functions";
import { runDailyPipeline } from "@/lib/pipeline.functions";
import { exportDraftsXlsx } from "@/lib/excel.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Sparkles,
  Play,
  Download,
  Check,
  X,
  ExternalLink,
  Loader2,
  ImageIcon,
} from "lucide-react";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

type Draft = {
  id: string;
  rank: number;
  title: string;
  source: string | null;
  url: string | null;
  summary: string | null;
  topic: string | null;
  image_url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  channels: Record<string, boolean> | null;
  status: string;
  post_results?: Array<{ channel: string; status: string; posted_url: string | null; error: string | null }>;
};

function Dashboard() {
  const qc = useQueryClient();
  const list = useServerFn(listDrafts);
  const run = useServerFn(runDailyPipeline);
  const exportFn = useServerFn(exportDraftsXlsx);

  const { data, isLoading } = useQuery({
    queryKey: ["drafts", "today"],
    queryFn: () => list({ data: {} }),
  });

  const runMut = useMutation({
    mutationFn: () => run(),
    onSuccess: (r) => {
      toast.success(`Generated ${r.count} drafts`);
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const exportMut = useMutation({
    mutationFn: () => exportFn({ data: {} }),
    onSuccess: (r) => {
      const link = document.createElement("a");
      link.href = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${r.base64}`;
      link.download = r.filename;
      link.click();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const drafts = (data?.drafts ?? []) as Draft[];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Sparkles className="h-5 w-5 text-primary" />
            Manuscripts Daily
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportMut.mutate()}
              disabled={exportMut.isPending || drafts.length === 0}
            >
              <Download className="mr-2 h-4 w-4" /> Excel
            </Button>
            <Button size="sm" onClick={() => runMut.mutate()} disabled={runMut.isPending}>
              {runMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run today
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Today's drafts</h1>
          <p className="text-sm text-muted-foreground">
            {data?.runDate} — {drafts.length} of 5 drafts. Approve to auto-post.
          </p>
        </div>

        {isLoading && <p className="text-muted-foreground">Loading…</p>}

        {!isLoading && drafts.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <ImageIcon className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                No drafts yet. Click <strong>Run today</strong> to generate the top 5.
              </p>
            </CardContent>
          </Card>
        )}

        <div className="space-y-6">
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </div>
      </main>
    </div>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const qc = useQueryClient();
  const update = useServerFn(updateDraft);
  const reject = useServerFn(rejectDraft);
  const approve = useServerFn(approveAndPost);

  const [caption, setCaption] = useState(draft.caption ?? "");
  const [hashtags, setHashtags] = useState((draft.hashtags ?? []).map((h) => `#${h}`).join(" "));
  const [channels, setChannels] = useState<Record<string, boolean>>(draft.channels ?? {
    linkedin: true, x: true, facebook: true, instagram: true,
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      update({
        data: {
          id: draft.id,
          caption,
          hashtags: hashtags.split(/\s+/).filter(Boolean).map((h) => h.replace(/^#/, "")),
          channels: {
            linkedin: !!channels.linkedin,
            x: !!channels.x,
            facebook: !!channels.facebook,
            instagram: !!channels.instagram,
          },
        },
      });
      setDirty(false);
    }, 600);
    return () => clearTimeout(t);
  }, [caption, hashtags, channels, dirty, draft.id, update]);

  const approveMut = useMutation({
    mutationFn: () => approve({ data: { id: draft.id } }),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.ok).length;
      const fail = r.results.length - ok;
      if (fail === 0) toast.success(`Posted to ${ok} channel${ok === 1 ? "" : "s"}`);
      else toast.error(`Posted ${ok}, failed ${fail}. Check post history.`);
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectMut = useMutation({
    mutationFn: () => reject({ data: { id: draft.id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drafts"] }),
  });

  const disabled = draft.status !== "pending" && draft.status !== "failed";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <Badge variant="secondary">#{draft.rank}</Badge>
            {draft.topic && <Badge variant="outline">{draft.topic}</Badge>}
            <Badge variant={draft.status === "posted" ? "default" : draft.status === "rejected" ? "destructive" : "outline"}>
              {draft.status}
            </Badge>
          </div>
          <h3 className="truncate text-lg font-semibold">{draft.title}</h3>
          {draft.url && (
            <a href={draft.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {draft.source} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 md:grid-cols-[240px_1fr]">
          {draft.image_url ? (
            <img src={draft.image_url} alt="" className="aspect-square w-full rounded-md border border-border object-cover" />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-md border border-border bg-muted">
              <ImageIcon className="h-8 w-8 text-muted-foreground" />
            </div>
          )}
          <div className="space-y-4">
            {draft.summary && <p className="text-sm text-muted-foreground">{draft.summary}</p>}
            <div className="space-y-1.5">
              <Label>Caption</Label>
              <Textarea
                value={caption}
                onChange={(e) => { setCaption(e.target.value); setDirty(true); }}
                rows={3}
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Hashtags</Label>
              <Input
                value={hashtags}
                onChange={(e) => { setHashtags(e.target.value); setDirty(true); }}
                disabled={disabled}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              {(["linkedin", "x", "facebook", "instagram"] as const).map((ch) => (
                <label key={ch} className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={!!channels[ch]}
                    onCheckedChange={(v) => { setChannels((c) => ({ ...c, [ch]: v })); setDirty(true); }}
                    disabled={disabled}
                  />
                  <span className="capitalize">{ch}</span>
                </label>
              ))}
            </div>

            {draft.post_results && draft.post_results.length > 0 && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <div className="mb-1 font-medium">Post history</div>
                {draft.post_results.map((r, i) => (
                  <div key={i} className="flex justify-between gap-2">
                    <span className="capitalize">{r.channel}</span>
                    {r.status === "success" && r.posted_url ? (
                      <a href={r.posted_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        View post <ExternalLink className="inline h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-destructive">{r.error ?? r.status}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button onClick={() => approveMut.mutate()} disabled={disabled || approveMut.isPending}>
                {approveMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                Approve & post
              </Button>
              <Button variant="outline" onClick={() => rejectMut.mutate()} disabled={disabled || rejectMut.isPending}>
                <X className="mr-2 h-4 w-4" /> Reject
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}