import { describe, expect, it } from "vitest";

import {
  buildDelayedReviewComment,
  buildFailedReviewComment,
  buildInlineReviewComment,
  buildNoFindingsComment,
  GitHubReviewFeedbackError,
} from "../../../src/lib/github/review-feedback";
import { parseReviewFinding } from "../../../src/lib/review/schema";

const commitId = "0123456789abcdef0123456789abcdef01234567";

const finding = parseReviewFinding({
  filePath: "src/api/review.ts",
  startLine: 24,
  endLine: 25,
  severity: "High",
  category: "authorization-bypass",
  summary: "The handler accepts a repository identifier without checking the caller's access.",
  reasoning: "A caller can select a repository they do not administer when this value is used without an authorization check.",
  snippet: "const repository = await loadRepository(request.query.id);\nreturn repository;",
  provenance: [
    {
      engineKind: "STATIC",
      engineIdentifier: "semgrep@1.176.0",
      staticRuleId: "sentirev.authorization-bypass",
    },
    {
      engineKind: "AI",
      engineIdentifier: "cohere/north-mini-code:free",
    },
  ],
});

describe("GitHub review feedback boundary", () => {
  it("builds a cited, range-aware inline comment without posting it", () => {
    const request = buildInlineReviewComment({
      repositoryFullName: "acme/review",
      pullRequestNumber: 17,
      commitId,
      finding,
    });

    expect(request.method).toBe("POST");
    expect(request.endpoint).toBe("/repos/acme/review/pulls/17/comments");
    expect(request.idempotencyKey).toMatch(/^sentirev:[a-f0-9]{64}$/u);
    expect(request.payload).toMatchObject({
      commit_id: commitId,
      path: "src/api/review.ts",
      line: 25,
      side: "RIGHT",
      start_line: 24,
      start_side: "RIGHT",
      subject_type: "line",
    });

    const body = request.payload.body;
    expect(body).toContain("**Severity: High**");
    expect(body).toContain("The handler accepts a repository identifier without checking the caller's access.");
    expect(body).toContain("**Location:** `src/api/review.ts:24-25`");
    expect(body).toContain("**Snippet**");
    expect(body).toContain("<summary>Reasoning</summary>");
    expect(body).toContain("**Detected by:** Semgrep (semgrep@1.176.0; rule sentirev.authorization-bypass), AI model (cohere/north-mini-code:free)");
    expect(body.indexOf("**Severity: High**")).toBeLessThan(body.indexOf("**Location:**"));
    expect(body.indexOf("**Location:**")).toBeLessThan(body.indexOf("**Snippet**"));
    expect(body.indexOf("**Snippet**")).toBeLessThan(body.indexOf("<summary>Reasoning</summary>"));
    expect(body.indexOf("<summary>Reasoning</summary>")).toBeLessThan(body.indexOf("**Detected by:**"));
    expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("uses a stable key for replay and changes it for a new head", () => {
    const input = {
      repositoryFullName: "acme/review",
      pullRequestNumber: 17,
      commitId,
      finding,
    };
    const first = buildInlineReviewComment(input);
    const replay = buildInlineReviewComment(input);
    const newHead = buildInlineReviewComment({ ...input, commitId: `${commitId.slice(0, -1)}8` });

    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    expect(newHead.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("builds explicit no-findings, delayed, and failed PR-level outcomes", () => {
    const input = { repositoryFullName: "acme/review", pullRequestNumber: 17, commitId };
    const noFindings = buildNoFindingsComment(input);
    const delayed = buildDelayedReviewComment(input);
    const failed = buildFailedReviewComment(input);

    for (const request of [noFindings, delayed, failed]) {
      expect(request.method).toBe("POST");
      expect(request.endpoint).toBe("/repos/acme/review/issues/17/comments");
      expect(request.payload.body).toContain("## SentiRev review");
      expect(request.payload.body).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
      expect(request.payload.body.toLowerCase()).not.toContain("resolved");
      expect(request.idempotencyKey).toMatch(/^sentirev:[a-f0-9]{64}$/u);
    }
    expect(noFindings.payload.body).toContain("No findings in the changed pull-request hunks.");
    expect(delayed.payload.body).toContain("Review delayed.");
    expect(delayed.payload.body).toContain("Retry from SentiRev");
    expect(failed.payload.body).toContain("Review failed.");
    expect(failed.payload.body).toContain("Retry from SentiRev");
    expect(failed.idempotencyKey).not.toBe(delayed.idempotencyKey);
  });

  it("rejects unsafe references and invalid findings without echoing input", () => {
    const secret = "owner-secret-value";

    expect(() => buildInlineReviewComment({
      repositoryFullName: `acme/${secret}/review`,
      pullRequestNumber: 17,
      commitId,
      finding,
    })).toThrowError(GitHubReviewFeedbackError);
    expect(() => buildInlineReviewComment({
      repositoryFullName: "acme/review",
      pullRequestNumber: 0,
      commitId,
      finding,
    })).toThrowError(GitHubReviewFeedbackError);
    expect(() => buildInlineReviewComment({
      repositoryFullName: "acme/review",
      pullRequestNumber: 17,
      commitId: "not-a-commit",
      finding,
    })).toThrowError(GitHubReviewFeedbackError);

    let error: unknown;
    try {
      buildInlineReviewComment({
        repositoryFullName: "acme/review",
        pullRequestNumber: 17,
        commitId,
        finding: { ...finding, filePath: "../secrets.ts" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "INVALID_FINDING" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
