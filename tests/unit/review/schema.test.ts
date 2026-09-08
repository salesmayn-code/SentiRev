import { describe, expect, it } from "vitest";

import {
  MAX_SNIPPET_LINES,
  normalizedFindingFingerprint,
  parseReviewFinding,
  reviewFindingSchema,
} from "@/lib/review/schema";

const validFinding = {
  filePath: "src/auth/check.ts",
  startLine: 7,
  endLine: 7,
  severity: "High" as const,
  category: "authorization-bypass",
  summary: "Admin access is not checked.",
  reasoning: "The route checks authentication but not the required admin role.",
  snippet: "if (!user.isAdmin) throw new Error('forbidden');",
  provenance: [{ engineKind: "STATIC" as const, engineIdentifier: "semgrep", staticRuleId: "sentirev.authz" }],
};

describe("review finding schema", () => {
  it("creates a deterministic fingerprint for valid bounded findings", () => {
    const finding = parseReviewFinding(validFinding);
    expect(finding.fingerprint).toBe(normalizedFindingFingerprint(validFinding));
    expect(finding.fingerprint).toHaveLength(64);
  });

  it("rejects unsafe paths, invalid locations, and invalid provenance", () => {
    expect(reviewFindingSchema.safeParse({ ...validFinding, filePath: "../secret.ts" }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...validFinding, endLine: 6 }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...validFinding, provenance: [{ engineKind: "STATIC", engineIdentifier: "semgrep" }] }).success).toBe(false);
  });

  it("rejects oversized snippets rather than silently truncating them", () => {
    const tooManyLines = Array.from({ length: MAX_SNIPPET_LINES + 1 }, () => "line").join("\n");
    expect(reviewFindingSchema.safeParse({ ...validFinding, snippet: tooManyLines }).success).toBe(false);
  });
});
