import { describe, expect, it } from "vitest";

import { mergeReviewFindings } from "@/lib/review/merge";
import { determineReviewOutcome } from "@/lib/review/outcomes";
import { parseReviewFinding, type ReviewFinding } from "@/lib/review/schema";
import { PRIMARY_MODEL } from "@/lib/review/providers/openrouter";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return parseReviewFinding({
    filePath: "src/auth.ts",
    startLine: 10,
    endLine: 10,
    severity: "Medium",
    category: "authorization-bypass",
    summary: "Authorization check is incomplete.",
    reasoning: "The privileged action lacks an admin role check.",
    snippet: "return exportReport(user.id);",
    provenance: [{ engineKind: "STATIC", engineIdentifier: "semgrep", staticRuleId: "sentirev.authz" }],
    ...overrides,
  });
}

describe("deterministic merge and outcomes", () => {
  it("deduplicates overlapping cross-engine findings, retains provenance, and takes highest severity", () => {
    const staticFinding = finding();
    const aiFinding = finding({
      startLine: 10,
      endLine: 11,
      severity: "High",
      provenance: [{ engineKind: "AI", engineIdentifier: PRIMARY_MODEL }],
    });

    const merged = mergeReviewFindings([aiFinding, staticFinding]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ severity: "High", startLine: 10, endLine: 11 });
    expect(merged[0].provenance).toHaveLength(2);
    expect(mergeReviewFindings([staticFinding, aiFinding])).toEqual(merged);
  });

  it("does not deduplicate distinct categories or non-touching spans", () => {
    expect(mergeReviewFindings([
      finding(),
      finding({ category: "unsafe-deserialization" }),
      finding({ startLine: 13, endLine: 13 }),
    ])).toHaveLength(3);
  });

  it("treats a valid zero-finding result as completed and a failed engine as partial", () => {
    expect(determineReviewOutcome([
      { path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "SUCCEEDED", durationMs: 1, findings: [] },
    ])).toBe("COMPLETED");
    expect(determineReviewOutcome([
      { path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "SUCCEEDED", durationMs: 1, findings: [] },
      { path: "AI", engineKind: "AI", engineIdentifier: PRIMARY_MODEL, code: "TIMED_OUT", durationMs: 60_000, findings: [] },
    ])).toBe("PARTIAL");
    expect(determineReviewOutcome([
      { path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "SUCCEEDED", durationMs: 1, findings: [] },
      { path: "AI", engineKind: "AI", engineIdentifier: PRIMARY_MODEL, code: "PARTIAL", durationMs: 3, findings: [finding({ provenance: [{ engineKind: "AI", engineIdentifier: PRIMARY_MODEL }] })] },
    ])).toBe("PARTIAL");
  });
});
