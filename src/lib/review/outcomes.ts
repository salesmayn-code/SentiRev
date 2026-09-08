import type { EngineKind, ReviewFinding } from "@/lib/review/schema";

export type EngineExecutionCode = "SUCCEEDED" | "PARTIAL" | "FAILED" | "TIMED_OUT" | "INVALID";
export type ReviewOutcome = "COMPLETED" | "PARTIAL" | "FAILED";

export type EngineExecution = {
  path: EngineKind;
  engineKind: EngineKind;
  engineIdentifier: string;
  code: EngineExecutionCode;
  durationMs: number;
  findings: ReviewFinding[];
};

export function isSuccessfulExecution(execution: EngineExecution): boolean {
  return execution.code === "SUCCEEDED";
}

export function hasValidResult(execution: EngineExecution): boolean {
  return execution.code === "SUCCEEDED" || execution.code === "PARTIAL";
}

/** A partial execution retains valid batch findings but keeps the AI path incomplete. */
export function determineReviewOutcome(executions: readonly EngineExecution[]): ReviewOutcome {
  const paths = new Map<EngineKind, { complete: boolean; valid: boolean }>();
  for (const execution of executions) {
    const current = paths.get(execution.path) ?? { complete: true, valid: false };
    current.complete = current.complete && isSuccessfulExecution(execution);
    current.valid = current.valid || hasValidResult(execution);
    paths.set(execution.path, current);
  }
  if (paths.size > 0 && [...paths.values()].every((path) => path.complete)) {
    return "COMPLETED";
  }
  return [...paths.values()].some((path) => path.valid) ? "PARTIAL" : "FAILED";
}

export function findingsFromSuccessfulExecutions(executions: readonly EngineExecution[]): ReviewFinding[] {
  return executions.flatMap((execution) => (hasValidResult(execution) ? execution.findings : []));
}
