import { createServerFn } from "@tanstack/react-start";

// Runs the daily pipeline: search news → pick top 5 → generate image + caption → save drafts.
export const runDailyPipeline = createServerFn({ method: "POST" }).handler(async () => {
  const { runPipeline } = await import("./pipeline.server");
  return runPipeline();
});
