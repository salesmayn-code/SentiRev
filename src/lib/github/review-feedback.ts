import { createHash } from "node:crypto";

import {
  isRepositoryRelativePath,
  parseReviewFinding,
  type ReviewFinding,
  type ReviewProvenance,
} from "@/lib/review/schema";

const GITHUB_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const COMMIT_ID_PATTERN = /^[A-Fa-f0-9]{7,128}$/u;

export type GitHubInlineReviewPayload = {
  body: string;
  commit_id: string;
  path: string;
  line: number;
  side: "RIGHT";
  subject_type: "line";
  start_line?: number;
  start_side?: "RIGHT";
};

export type GitHubIssueCommentPayload = {
  body: string;
};

export type GitHubCommentRequest<TPayload> = {
  method: "POST";
  endpoint: string;
  idempotencyKey: string;
  payload: TPayload;
};

export type InlineReviewCommentInput = {
  repositoryFullName: string;
  pullRequestNumber: number;
  commitId: string;
  finding: ReviewFinding;
};

export type PullRequestOutcomeInput = {
  repositoryFullName: string;
  pullRequestNumber: number;
  commitId: string;
};

export type PullRequestOutcome = "NO_FINDINGS" | "DELAYED" | "FAILED";

const builtCommentRequests = new WeakSet<object>();

export class GitHubReviewFeedbackError extends Error {
  readonly code:
    | "INVALID_REPOSITORY"
    | "INVALID_PULL_REQUEST"
    | "INVALID_COMMIT"
    | "INVALID_FINDING";

  constructor(
    code: GitHubReviewFeedbackError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GitHubReviewFeedbackError";
    this.code = code;
  }
}

function registerCommentRequest<TPayload>(
  request: GitHubCommentRequest<TPayload>,
): GitHubCommentRequest<TPayload> {
  if (typeof request.payload === "object" && request.payload !== null) {
    Object.freeze(request.payload);
  }
  Object.freeze(request);
  builtCommentRequests.add(request);
  return request;
}

/** Runtime guard used by the client submission boundary. */
export function isGitHubCommentRequest(
  value: unknown,
): value is GitHubCommentRequest<unknown> {
  return typeof value === "object" && value !== null && builtCommentRequests.has(value);
}

function parseRepositoryReference(fullName: string): { owner: string; name: string } {
  if (typeof fullName !== "string") {
    throw new GitHubReviewFeedbackError(
      "INVALID_REPOSITORY",
      "The GitHub repository reference is invalid",
    );
  }
  const parts = fullName.split("/");
  if (
    parts.length !== 2
    || !GITHUB_NAME_PART.test(parts[0])
    || !GITHUB_NAME_PART.test(parts[1])
  ) {
    throw new GitHubReviewFeedbackError(
      "INVALID_REPOSITORY",
      "The GitHub repository reference is invalid",
    );
  }
  return { owner: parts[0], name: parts[1] };
}

function validatePullRequestNumber(pullRequestNumber: number): number {
  if (
    !Number.isSafeInteger(pullRequestNumber)
    || pullRequestNumber <= 0
    || pullRequestNumber > 2_147_483_647
  ) {
    throw new GitHubReviewFeedbackError(
      "INVALID_PULL_REQUEST",
      "The GitHub pull request reference is invalid",
    );
  }
  return pullRequestNumber;
}

function validateCommitId(commitId: string): string {
  if (typeof commitId !== "string" || !COMMIT_ID_PATTERN.test(commitId)) {
    throw new GitHubReviewFeedbackError(
      "INVALID_COMMIT",
      "The GitHub commit reference is invalid",
    );
  }
  return commitId;
}

function safeFinding(finding: ReviewFinding): ReviewFinding {
  try {
    const parsed = parseReviewFinding(finding);
    if (!isRepositoryRelativePath(parsed.filePath)) {
      throw new Error("unsafe path");
    }
    return parsed;
  } catch {
    throw new GitHubReviewFeedbackError(
      "INVALID_FINDING",
      "The review finding citation is invalid",
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function oneLine(value: string): string {
  return escapeHtml(value.replace(/\s+/gu, " ").trim());
}

function codeFence(value: string): string {
  const runs = value.match(/~+/gu) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "~".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${value}\n${fence}`;
}

function reasoningBlock(reasoning: string): string {
  const lines = escapeHtml(reasoning).split(/\r?\n/u);
  return [
    "<details>",
    "<summary>Reasoning</summary>",
    "",
    lines.map((line) => `> ${line}`).join("\n"),
    "",
    "</details>",
  ].join("\n");
}

function provenanceLabel(provenance: ReviewProvenance): string {
  const engine = provenance.engineKind === "STATIC" ? "Semgrep" : "AI model";
  const identifier = escapeHtml(provenance.engineIdentifier);
  const rule = provenance.staticRuleId
    ? `; rule ${escapeHtml(provenance.staticRuleId)}`
    : "";
  return `${engine} (${identifier}${rule})`;
}

function engineAttribution(finding: ReviewFinding): string {
  const labels = [...finding.provenance]
    .map(provenanceLabel)
    .filter((label, index, all) => all.indexOf(label) === index);
  return labels.join(", ");
}

function inlineBody(finding: ReviewFinding): string {
  const citation = finding.startLine === finding.endLine
    ? `${finding.filePath}:${finding.startLine}`
    : `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
  return [
    `**Severity: ${finding.severity}**`,
    "",
    oneLine(finding.summary),
    "",
    `**Location:** \`${citation}\``,
    "",
    "**Snippet**",
    codeFence(finding.snippet),
    "",
    reasoningBlock(finding.reasoning),
    "",
    `**Detected by:** ${engineAttribution(finding)}`,
  ].join("\n");
}

function idempotencyKey(
  outcome: string,
  repositoryFullName: string,
  pullRequestNumber: number,
  commitId: string,
  fingerprint: string,
): string {
  return `sentirev:${createHash("sha256")
    .update(
      [outcome, repositoryFullName, String(pullRequestNumber), commitId, fingerprint].join("\0"),
      "utf8",
    )
    .digest("hex")}`;
}

function pullRequestCommentEndpoint(
  repositoryFullName: string,
  pullRequestNumber: number,
  resource: "comments" | "issue-comments",
): string {
  const { owner, name } = parseRepositoryReference(repositoryFullName);
  const number = validatePullRequestNumber(pullRequestNumber);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return resource === "comments"
    ? `${base}/pulls/${number}/comments`
    : `${base}/issues/${number}/comments`;
}

/**
 * Builds, but does not submit, one GitHub inline review-comment request. The
 * body order mirrors the approved review contract: severity, summary, cited
 * location, bounded snippet, expandable reasoning, then engine provenance.
 */
export function buildInlineReviewComment(
  input: InlineReviewCommentInput,
): GitHubCommentRequest<GitHubInlineReviewPayload> {
  const repository = parseRepositoryReference(input.repositoryFullName);
  const pullRequestNumber = validatePullRequestNumber(input.pullRequestNumber);
  const commitId = validateCommitId(input.commitId);
  const finding = safeFinding(input.finding);
  const payload: GitHubInlineReviewPayload = {
    body: inlineBody(finding),
    commit_id: commitId,
    path: finding.filePath,
    line: finding.endLine,
    side: "RIGHT",
    subject_type: "line",
  };
  if (finding.startLine !== finding.endLine) {
    payload.start_line = finding.startLine;
    payload.start_side = "RIGHT";
  }
  return registerCommentRequest({
    method: "POST",
    endpoint: pullRequestCommentEndpoint(
      input.repositoryFullName,
      pullRequestNumber,
      "comments",
    ),
    idempotencyKey: idempotencyKey(
      "finding",
      `${repository.owner}/${repository.name}`,
      pullRequestNumber,
      commitId,
      finding.fingerprint,
    ),
    payload,
  });
}

const PULL_REQUEST_OUTCOME_COPY: Readonly<Record<PullRequestOutcome, string>> = {
  NO_FINDINGS: [
    "## SentiRev review",
    "",
    "No findings in the changed pull-request hunks.",
    "",
    "The review completed without a supported issue in the changed hunks. Findings are advisory and do not block merging.",
  ].join("\n"),
  DELAYED: [
    "## SentiRev review",
    "",
    "Review delayed.",
    "",
    "The static review completed, but the AI review was delayed because the configured provider was unavailable or rate-limited. Any static findings are listed above. Retry from SentiRev when the provider is available. Findings are advisory and do not block merging.",
  ].join("\n"),
  FAILED: [
    "## SentiRev review",
    "",
    "Review failed.",
    "",
    "SentiRev could not complete this review, so it has no complete finding result to report. Retry from SentiRev. Findings are advisory and do not block merging.",
  ].join("\n"),
};

/** Builds, but does not submit, an explicit PR-level outcome comment. */
export function buildPullRequestOutcomeComment(
  outcome: PullRequestOutcome,
  input: PullRequestOutcomeInput,
): GitHubCommentRequest<GitHubIssueCommentPayload> {
  const repository = parseRepositoryReference(input.repositoryFullName);
  const pullRequestNumber = validatePullRequestNumber(input.pullRequestNumber);
  const commitId = validateCommitId(input.commitId);
  return registerCommentRequest({
    method: "POST",
    endpoint: pullRequestCommentEndpoint(
      input.repositoryFullName,
      pullRequestNumber,
      "issue-comments",
    ),
    idempotencyKey: idempotencyKey(
      outcome,
      `${repository.owner}/${repository.name}`,
      pullRequestNumber,
      commitId,
      outcome,
    ),
    payload: { body: PULL_REQUEST_OUTCOME_COPY[outcome] },
  });
}

export function buildNoFindingsComment(
  input: PullRequestOutcomeInput,
): GitHubCommentRequest<GitHubIssueCommentPayload> {
  return buildPullRequestOutcomeComment("NO_FINDINGS", input);
}

export function buildDelayedReviewComment(
  input: PullRequestOutcomeInput,
): GitHubCommentRequest<GitHubIssueCommentPayload> {
  return buildPullRequestOutcomeComment("DELAYED", input);
}

export function buildFailedReviewComment(
  input: PullRequestOutcomeInput,
): GitHubCommentRequest<GitHubIssueCommentPayload> {
  return buildPullRequestOutcomeComment("FAILED", input);
}
