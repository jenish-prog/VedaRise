import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listDrafts, updateDraft, rejectDraft, approveAndPost, getArticleContent, regenerateDraft, regenerateImageDraft, regenerateCaptionDraft, regenerateHashtagsDraft } from "@/lib/drafts.functions";
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
import { Sparkles, Play, Download, Check, X, ExternalLink, Loader2, ImageIcon, RefreshCw } from "lucide-react";

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
  post_results?: Array<{
    channel: string;
    status: string;
    posted_url: string | null;
    error: string | null;
  }>;
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
            <Button size="sm" onClick={() => runMut.mutate()} disabled={runMut.isPending || drafts.length > 0}>
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

        <div className="space-y-10">
          {drafts.map((d, index) => (
            <div key={d.id} className="space-y-10">
              <DraftCard draft={d} />
              {index < drafts.length - 1 && <hr className="border-t border-border/50" />}
            </div>
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
  const regenerate = useServerFn(regenerateDraft);
  const regenerateImage = useServerFn(regenerateImageDraft);
  const regenerateCaption = useServerFn(regenerateCaptionDraft);
  const regenerateHashtags = useServerFn(regenerateHashtagsDraft);

  const [caption, setCaption] = useState(draft.caption ?? "");
  const [hashtags, setHashtags] = useState((draft.hashtags ?? []).map((h) => `#${h}`).join(" "));
  const [channels, setChannels] = useState<Record<string, boolean>>(
    draft.channels ?? {
      linkedin: true,
      x: true,
      facebook: true,
      instagram: true,
    },
  );
  const [dirty, setDirty] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [leftChannels, setLeftChannels] = useState<Record<string, boolean>>({
    linkedin: true,
    website: true,
  });

  const [isEditingArticle, setIsEditingArticle] = useState(false);
  const [editTitle, setEditTitle] = useState(draft.title ?? "");
  const [editSummary, setEditSummary] = useState(draft.summary ?? "");
  const [articleDirty, setArticleDirty] = useState(false);

  const fetchContent = useServerFn(getArticleContent);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [errorContent, setErrorContent] = useState<string | null>(null);

  const handleToggleExpand = async () => {
    if (!isExpanded && !fullContent && draft.url) {
      setLoadingContent(true);
      setErrorContent(null);
      try {
        const res = await fetchContent({ data: { url: draft.url } });
        setFullContent(res.content);
      } catch (err) {
        setErrorContent(err instanceof Error ? err.message : "Failed to load content");
      } finally {
        setLoadingContent(false);
      }
    }
    setIsExpanded(!isExpanded);
  };

  useEffect(() => {
    setEditTitle(draft.title ?? "");
    setEditSummary(draft.summary ?? "");
    setCaption(draft.caption ?? "");
    setHashtags((draft.hashtags ?? []).map((h) => `#${h}`).join(" "));
    setDirty(false);
  }, [draft.title, draft.summary, draft.caption, draft.hashtags]);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      update({
        data: {
          id: draft.id,
          caption,
          hashtags: hashtags
            .split(/\s+/)
            .filter(Boolean)
            .map((h) => h.replace(/^#/, "")),
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

  useEffect(() => {
    if (!articleDirty) return;
    const t = setTimeout(() => {
      update({
        data: {
          id: draft.id,
          title: editTitle,
          summary: editSummary,
        },
      });
      setArticleDirty(false);
    }, 600);
    return () => clearTimeout(t);
  }, [editTitle, editSummary, articleDirty, draft.id, update]);

  const approveMut = useMutation({
    mutationFn: (params?: { channels?: Record<string, boolean> }) =>
      approve({ data: { id: draft.id, channels: params?.channels } }),
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

  const regenerateMut = useMutation({
    mutationFn: () => regenerate({ data: { id: draft.id } }),
    onSuccess: () => {
      toast.success("Article successfully regenerated!");
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const regenerateImageMut = useMutation({
    mutationFn: () => regenerateImage({ data: { id: draft.id } }),
    onSuccess: () => {
      toast.success("Image successfully regenerated!");
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const regenerateCaptionMut = useMutation({
    mutationFn: () => regenerateCaption({ data: { id: draft.id } }),
    onSuccess: () => {
      toast.success("Caption successfully regenerated!");
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const regenerateHashtagsMut = useMutation({
    mutationFn: () => regenerateHashtags({ data: { id: draft.id } }),
    onSuccess: () => {
      toast.success("Hashtags successfully regenerated!");
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disabled = draft.status !== "pending" && draft.status !== "failed";

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Box 1: Article details */}
      <Card className="flex flex-col justify-between h-full">
        <div>
          <CardHeader className="flex flex-col items-start gap-2">
            <div className="flex w-full items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">#{draft.rank}</Badge>
                {draft.topic && <Badge variant="outline">{draft.topic}</Badge>}
              </div>
              <Badge
                variant={
                  draft.status === "posted"
                    ? "default"
                    : draft.status === "rejected"
                      ? "destructive"
                      : "outline"
                }
              >
                {draft.status}
              </Badge>
            </div>
            {isEditingArticle ? (
              <div className="w-full space-y-1.5 mt-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Article Title</Label>
                <Input
                  value={editTitle}
                  onChange={(e) => {
                    setEditTitle(e.target.value);
                    setArticleDirty(true);
                  }}
                  disabled={disabled || regenerateMut.isPending}
                />
              </div>
            ) : (
              <h3 className="text-lg font-bold leading-snug mt-2 text-foreground">{editTitle}</h3>
            )}
            {draft.url && (
              <a
                href={draft.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                {draft.source || "Source link"} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {draft.summary && (
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Article Summary
                </Label>
                {isEditingArticle ? (
                  <Textarea
                    value={editSummary}
                    onChange={(e) => {
                      setEditSummary(e.target.value);
                      setArticleDirty(true);
                    }}
                    rows={4}
                    className="resize-none"
                    disabled={disabled || regenerateMut.isPending}
                  />
                ) : (
                  <div className="rounded-md border border-border bg-muted/20 p-4 text-sm leading-relaxed text-foreground">
                    {isExpanded ? (
                      loadingContent ? (
                        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                          <Loader2 className="h-5 w-5 animate-spin mb-2" />
                          Fetching article content...
                        </div>
                      ) : errorContent ? (
                        <div className="text-destructive py-2 text-xs">
                          {errorContent}. <a href={draft.url || "#"} target="_blank" rel="noreferrer" className="underline font-medium text-primary">Read on source site</a>.
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap max-h-80 overflow-y-auto pr-2 text-xs md:text-sm">
                          {fullContent || editSummary}
                        </div>
                      )
                    ) : (
                      <div className="line-clamp-3">{editSummary}</div>
                    )}
                    {draft.url && (
                      <button
                        onClick={handleToggleExpand}
                        className="mt-2 text-xs font-semibold text-primary hover:underline cursor-pointer block"
                      >
                        {isExpanded ? "Show summary" : "View full article"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </div>
        <CardContent className="pt-0 space-y-4">
          <div className="space-y-2 border-t border-border pt-4">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Channels
            </Label>
            <div className="grid grid-cols-2 gap-2">
              {(["linkedin", "website"] as const).map((ch) => (
                <label
                  key={ch}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/10 p-2 text-sm hover:bg-muted/20 cursor-pointer"
                >
                  <Switch
                    checked={!!leftChannels[ch]}
                    onCheckedChange={(v) => {
                      setLeftChannels((c) => ({ ...c, [ch]: v }));
                    }}
                    disabled={disabled}
                  />
                  <span className="capitalize">{ch}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-4 border-t border-border">
            <Button
              onClick={() => approveMut.mutate({ channels: leftChannels })}
              disabled={disabled || approveMut.isPending || regenerateMut.isPending || (!leftChannels.linkedin && !leftChannels.website)}
              className="flex-1"
            >
              {approveMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Approve & post
            </Button>
            <Button
              variant="outline"
              onClick={() => setIsEditingArticle(!isEditingArticle)}
              disabled={disabled || approveMut.isPending || regenerateMut.isPending}
            >
              {isEditingArticle ? "Done" : "Edit"}
            </Button>
            <Button
              variant="outline"
              onClick={() => regenerateMut.mutate()}
              disabled={disabled || approveMut.isPending || regenerateMut.isPending}
            >
              {regenerateMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Regenerate
            </Button>
            <Button
              variant="outline"
              onClick={() => rejectMut.mutate()}
              disabled={disabled || rejectMut.isPending || regenerateMut.isPending}
            >
              <X className="mr-2 h-4 w-4" /> Reject
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Box 2: Social Post details */}
      <Card className="flex flex-col justify-between h-full">
        <div>
          <CardHeader>
            <h3 className="text-base font-semibold text-foreground">Social Post & Assets</h3>
            <p className="text-xs text-muted-foreground">
              Adjust the generated media, caption, hashtags, and select target channels.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Post Image
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => regenerateImageMut.mutate()}
                    disabled={disabled || regenerateImageMut.isPending}
                    title="Regenerate Image"
                  >
                    {regenerateImageMut.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <div className="relative aspect-square w-full rounded-md border border-border overflow-hidden">
                  {draft.image_url ? (
                    <img
                      src={draft.image_url}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="flex w-full h-full items-center justify-center bg-muted">
                      <ImageIcon className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                  {regenerateImageMut.isPending && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-xs">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Caption
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={() => regenerateCaptionMut.mutate()}
                      disabled={disabled || regenerateCaptionMut.isPending}
                      title="Regenerate Caption"
                    >
                      {regenerateCaptionMut.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="relative">
                    <Textarea
                      value={caption}
                      onChange={(e) => {
                        setCaption(e.target.value);
                        setDirty(true);
                      }}
                      rows={4}
                      className="resize-none"
                      disabled={disabled || regenerateCaptionMut.isPending}
                    />
                    {regenerateCaptionMut.isPending && (
                      <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-xs rounded-md">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      </div>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Hashtags
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer"
                      onClick={() => regenerateHashtagsMut.mutate()}
                      disabled={disabled || regenerateHashtagsMut.isPending}
                      title="Regenerate Hashtags"
                    >
                      {regenerateHashtagsMut.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="relative">
                    <Input
                      value={hashtags}
                      onChange={(e) => {
                        setHashtags(e.target.value);
                        setDirty(true);
                      }}
                      disabled={disabled || regenerateHashtagsMut.isPending}
                    />
                    {regenerateHashtagsMut.isPending && (
                      <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-xs rounded-md">
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Channels
              </Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(["linkedin", "x", "facebook", "instagram"] as const).map((ch) => (
                  <label
                    key={ch}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/10 p-2 text-sm hover:bg-muted/20 cursor-pointer"
                  >
                    <Switch
                      checked={!!channels[ch]}
                      onCheckedChange={(v) => {
                        setChannels((c) => ({ ...c, [ch]: v }));
                        setDirty(true);
                      }}
                      disabled={disabled}
                    />
                    <span className="capitalize">{ch}</span>
                  </label>
                ))}
              </div>
            </div>

            {draft.post_results && draft.post_results.length > 0 && (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <div className="mb-1 font-medium">Post history</div>
                {draft.post_results.map((r, i) => (
                  <div key={i} className="flex justify-between gap-2">
                    <span className="capitalize">{r.channel}</span>
                    {r.status === "success" && r.posted_url ? (
                      <a
                        href={r.posted_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        View post <ExternalLink className="inline h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-destructive">{r.error ?? r.status}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </div>

        <CardContent className="pt-0">
          <div className="flex gap-2 pt-4 border-t border-border">
            <Button
              onClick={() => approveMut.mutate({})}
              disabled={disabled || approveMut.isPending}
              className="flex-1"
            >
              {approveMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Approve & post
            </Button>
            <Button
              variant="outline"
              onClick={() => rejectMut.mutate()}
              disabled={disabled || rejectMut.isPending}
            >
              <X className="mr-2 h-4 w-4" /> Reject
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
