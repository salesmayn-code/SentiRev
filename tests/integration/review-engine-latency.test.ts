import { describe, expect, it } from "vitest";

import { executeReview, type ReviewChunk } from "@/lib/review/service";

function chunks(changedLineCount: number): ReviewChunk[] {
  return [{ filePath: "src/example.ts", text: "const synthetic = true;", changedNewLines: Array.from({ length: changedLineCount }, (_, index) => index + 1) }];
}

describe("Phase 003 latency cohort", () => {
  it("labels representative diffs inside and oversized diffs outside the three-minute cohort", async () => {
    const persistInputs: Array<{ outsideLatencyCohort: boolean; changedLineCount: number; reviewDurationMs: number }> = [];
    let now = 0;
    const dependencies = {
      parseDiff: () => chunks(499),
      runStatic: async () => ({ path: "STATIC" as const, engineKind: "STATIC" as const, engineIdentifier: "semgrep", code: "SUCCEEDED" as const, durationMs: 8, findings: [] }),
      runAi: async () => [],
      existing: async () => undefined,
      clock: () => (now += 10),
      persist: async (input: { outsideLatencyCohort: boolean; changedLineCount: number; reviewDurationMs: number }) => { persistInputs.push(input); return { replayed: false, status: input.outsideLatencyCohort ? "PARTIAL" as const : "COMPLETED" as const, findingCount: 0 }; },
    };
    await executeReview({ foundationJobId: "synthetic-under", rawDiff: "synthetic", consent: "STATIC_ONLY" }, dependencies);
    await executeReview({ foundationJobId: "synthetic-over", rawDiff: "synthetic", consent: "STATIC_ONLY" }, { ...dependencies, parseDiff: () => chunks(501) });
    expect(persistInputs).toEqual([
      expect.objectContaining({ changedLineCount: 499, outsideLatencyCohort: false, reviewDurationMs: 10 }),
      expect.objectContaining({ changedLineCount: 501, outsideLatencyCohort: true, reviewDurationMs: 10 }),
    ]);
  });
});
