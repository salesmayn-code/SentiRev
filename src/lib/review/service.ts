import { mergeReviewFindings } from "@/lib/review/merge";
import {
  determineReviewOutcome,
  findingsFromSuccessfulExecutions,
  type EngineExecution,
} from "@/lib/review/outcomes";
import {
  getPersistedReviewResult,
  persistReviewResult,
  type PersistReviewResult,
} from "@/lib/review/persistence";
import type { DiffChunk } from "@/lib/review/diff";
import { PRIMARY_MODEL } from "@/lib/review/providers/openrouter";

export type ReviewChunk = {
  filePath: string;
  text: string;
  changedNewLines: number[];
  /** Ephemeral parser detail for engine adapters; never passed to persistence. */
  source?: DiffChunk;
};

export type ReviewServiceInput = {
  foundationJobId: string;
  rawDiff: string;
  consent: "AI_ALLOWED" | "STATIC_ONLY";
};

export type ReviewServiceDependencies = {
  parseDiff: (rawDiff: string) => ReviewChunk[];
  runStatic: (chunks: ReviewChunk[], signal: AbortSignal) => Promise<EngineExecution>;
  runAi: (chunks: ReviewChunk[], signal: AbortSignal) => Promise<EngineExecution[]>;
  persist?: (input: Parameters<typeof persistReviewResult>[0]) => Promise<PersistReviewResult>;
  existing?: (foundationJobId: string) => Promise<PersistReviewResult | undefined>;
  clock?: () => number;
};

const INTERNAL_REVIEW_BUDGET_MS = 165_000;

function failedExecution(path: "STATIC" | "AI", engineIdentifier: string, startedAt: number, code: "FAILED" | "TIMED_OUT" = "FAILED"): EngineExecution {
  return {
    path,
    engineKind: path,
    engineIdentifier,
    code,
    durationMs: Math.max(0, Date.now() - startedAt),
    findings: [],
  };
}

async function captureStatic(
  runner: ReviewServiceDependencies["runStatic"],
  chunks: ReviewChunk[],
  signal: AbortSignal,
  startedAt: number,
): Promise<EngineExecution> {
  try {
    return await runner(chunks, signal);
  } catch {
    return failedExecution("STATIC", "semgrep", startedAt, signal.aborted ? "TIMED_OUT" : "FAILED");
  }
}

async function captureAi(
  runner: ReviewServiceDependencies["runAi"],
  chunks: ReviewChunk[],
  signal: AbortSignal,
  startedAt: number,
): Promise<EngineExecution[]> {
  try {
    return await runner(chunks, signal);
  } catch {
    return [failedExecution("AI", PRIMARY_MODEL, startedAt, signal.aborted ? "TIMED_OUT" : "FAILED")];
  }
}

/**
 * Composes validated boundaries without storing the input diff. GitHub event
 * retrieval, queue wiring, and comment posting remain intentionally deferred.
 */
export async function executeReview(
  input: ReviewServiceInput,
  dependencies: ReviewServiceDependencies,
): Promise<PersistReviewResult> {
  const startedAt = (dependencies.clock ?? Date.now)();
  const existing = await (dependencies.existing ?? getPersistedReviewResult)(input.foundationJobId);
  if (existing) return existing;
  const chunks = dependencies.parseDiff(input.rawDiff);
  const changedLineCount = chunks.reduce((total, chunk) => total + chunk.changedNewLines.length, 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTERNAL_REVIEW_BUDGET_MS);
  const signal = controller.signal;

  try {
    const staticPromise = captureStatic(dependencies.runStatic, chunks, signal, startedAt);
    const aiPromise = input.consent === "AI_ALLOWED"
      ? captureAi(dependencies.runAi, chunks, signal, startedAt)
      : Promise.resolve([] as EngineExecution[]);
    const [staticExecution, aiExecutions] = await Promise.all([staticPromise, aiPromise]);
    const executions = [staticExecution, ...aiExecutions];
    const outcome = determineReviewOutcome(executions);
    const findings = mergeReviewFindings(findingsFromSuccessfulExecutions(executions));
    return (dependencies.persist ?? persistReviewResult)({
      foundationJobId: input.foundationJobId,
      changedLineCount,
      outsideLatencyCohort: changedLineCount > 500,
      reviewDurationMs: Math.max(0, (dependencies.clock ?? Date.now)() - startedAt),
      outcome,
      findings,
      executions,
    });
  } finally {
    clearTimeout(timer);
  }
}
