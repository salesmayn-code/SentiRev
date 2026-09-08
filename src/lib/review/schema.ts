import { createHash } from "node:crypto";

import { z } from "zod";

export const REVIEW_SEVERITIES = ["Critical", "High", "Medium", "Low"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const ENGINE_KINDS = ["STATIC", "AI"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export const MAX_SUMMARY_LENGTH = 160;
export const MAX_REASONING_LENGTH = 2_000;
export const MAX_SNIPPET_LINES = 12;
export const MAX_SNIPPET_BYTES = 2_000;

const repositoryPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => (
      !value.startsWith("/")
      && !/^[A-Za-z]:[\\/]/u.test(value)
      && !value.includes("\\")
      && !value.split("/").includes("..")
      && /^[A-Za-z0-9._@+\-/]+$/u.test(value)
    ),
    "filePath must be a safe repository-relative slash path",
  );

const positiveLine = z.number().int().positive().max(10_000_000);

export const reviewProvenanceSchema = z.object({
  engineKind: z.enum(ENGINE_KINDS),
  engineIdentifier: z.string().min(1).max(160),
  staticRuleId: z.string().min(1).max(300).optional(),
}).superRefine((value, context) => {
  if (value.engineKind === "STATIC" && !value.staticRuleId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "STATIC provenance requires staticRuleId" });
  }
  if (value.engineKind === "AI" && value.staticRuleId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "AI provenance must not include staticRuleId" });
  }
});

export type ReviewProvenance = z.infer<typeof reviewProvenanceSchema>;

function snippetIsBounded(value: string): boolean {
  return value.split("\n").length <= MAX_SNIPPET_LINES && Buffer.byteLength(value, "utf8") <= MAX_SNIPPET_BYTES;
}

export const reviewFindingSchema = z.object({
  filePath: repositoryPath,
  startLine: positiveLine,
  endLine: positiveLine,
  severity: z.enum(REVIEW_SEVERITIES),
  category: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/u),
  summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH),
  reasoning: z.string().trim().min(1).max(MAX_REASONING_LENGTH),
  snippet: z.string().min(1).refine(snippetIsBounded, "snippet exceeds the Phase 003 bound"),
  provenance: z.array(reviewProvenanceSchema).min(1).max(8),
}).superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "endLine must be on or after startLine" });
  }
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema> & { fingerprint: string };
export type ReviewFindingInput = z.input<typeof reviewFindingSchema>;

export const engineResultSchema = z.object({
  engineKind: z.enum(ENGINE_KINDS),
  engineIdentifier: z.string().min(1).max(160),
  findings: z.array(reviewFindingSchema).max(200),
});
export type EngineResult = z.infer<typeof engineResultSchema>;

export function normalizedFindingFingerprint(finding: Pick<ReviewFindingInput, "filePath" | "startLine" | "endLine" | "category">): string {
  return createHash("sha256")
    .update(`${finding.filePath}:${finding.startLine}:${finding.endLine}:${finding.category}`, "utf8")
    .digest("hex");
}

export function parseReviewFinding(value: unknown): ReviewFinding {
  const parsed = reviewFindingSchema.parse(value);
  return { ...parsed, fingerprint: normalizedFindingFingerprint(parsed) };
}

export function severityRank(severity: ReviewSeverity): number {
  return { Critical: 4, High: 3, Medium: 2, Low: 1 }[severity];
}

export function isRepositoryRelativePath(value: string): boolean {
  return repositoryPath.safeParse(value).success;
}
