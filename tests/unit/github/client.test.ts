import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPullRequestDiff,
  getGitHubAppInstallUrl,
  getRepositoryForUser,
  isRepositoryAdmin,
  submitGitHubComment,
} from "../../../src/lib/github/client";
import {
  buildNoFindingsComment,
  buildInlineReviewComment,
} from "../../../src/lib/github/review-feedback";
import { parseReviewFinding } from "../../../src/lib/review/schema";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub client boundary", () => {
  const inlineRequest = buildInlineReviewComment({
    repositoryFullName: "acme/review",
    pullRequestNumber: 17,
    commitId: "0123456789abcdef0123456789abcdef01234567",
    finding: parseReviewFinding({
      filePath: "src/review.ts",
      startLine: 24,
      endLine: 24,
      severity: "Medium",
      category: "unsafe-input",
      summary: "Input reaches the parser without validation.",
      reasoning: "The changed value is passed to the parser before its shape is checked.",
      snippet: "parse(input);",
      provenance: [{
        engineKind: "STATIC",
        engineIdentifier: "semgrep@1.176.0",
        staticRuleId: "sentirev.unsafe-input",
      }],
    }),
  });

  it("creates a state-carrying App installation URL", () => {
    const url = new URL(getGitHubAppInstallUrl("state-value", "sentirev"));

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/apps/sentirev/installations/new");
    expect(url.searchParams.get("state")).toBe("state-value");
  });

  it("returns repository permissions for server-side admin checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 123,
            name: "demo",
            full_name: "acme/demo",
            owner: { login: "acme" },
            permissions: { admin: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const repository = await getRepositoryForUser("oauth-token", "acme/demo");

    expect(repository.full_name).toBe("acme/demo");
    expect(isRepositoryAdmin(repository)).toBe(true);
  });

  it("does not treat a missing admin permission as authorization", () => {
    expect(
      isRepositoryAdmin({
        id: 123,
        name: "demo",
        full_name: "acme/demo",
        owner: { login: "acme" },
        permissions: { admin: false },
      }),
    ).toBe(false);
    expect(
      isRepositoryAdmin({
        id: 123,
        name: "demo",
        full_name: "acme/demo",
        owner: { login: "acme" },
      }),
    ).toBe(false);
  });

  it("retrieves only the bounded unified diff with the installation token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1 +1 @@\n-old\n+new\n",
        { status: 200, headers: { "Content-Type": "text/plain" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const diff = await getPullRequestDiff(
      "installation-token",
      "acme/review",
      17,
    );

    expect(diff).toContain("diff --git a/src/review.ts b/src/review.ts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://api.github.com/repos/acme/review/pulls/17");
    expect(requestInit.method).toBeUndefined();
    expect(requestInit.headers).toMatchObject({
      Accept: "application/vnd.github.v3.diff",
      Authorization: "Bearer installation-token",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("rejects invalid references before making an external request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getPullRequestDiff("installation-token", "acme/../review", 17),
    ).rejects.toMatchObject({ code: "INVALID_REPOSITORY" });
    await expect(
      getPullRequestDiff("installation-token", "acme/review", 0),
    ).rejects.toMatchObject({ code: "INVALID_PULL_REQUEST" });
    await expect(
      getPullRequestDiff("secret token", "acme/review", 17),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized response without returning its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("this diff is too large", { status: 200 }),
      ),
    );

    const error = await getPullRequestDiff(
      "installation-token",
      "acme/review",
      17,
      { maxBytes: 4 },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "DIFF_TOO_LARGE" });
    expect((error as Error).message).not.toContain("this diff is too large");
  });

  it("rejects a non-text response and never exposes a token in the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
      ),
    );

    const error = await getPullRequestDiff(
      "installation-token",
      "acme/review",
      17,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "INVALID_DIFF" });
    expect(JSON.stringify(error)).not.toContain("installation-token");
  });

  it("submits only a built descriptor and returns sanitized acknowledgement metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 456, body: "provider response is not returned" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const acknowledgement = await submitGitHubComment("installation-token", inlineRequest);

    expect(acknowledgement).toEqual({
      accepted: true,
      status: 201,
      idempotencyKey: inlineRequest.idempotencyKey,
      githubCommentId: 456,
    });
    expect(acknowledgement).not.toHaveProperty("body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://api.github.com/repos/acme/review/pulls/17/comments");
    expect(requestInit).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer installation-token",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    expect(JSON.parse(String(requestInit.body))).toEqual(inlineRequest.payload);
  });

  it("sanitizes GitHub failures and does not return the response body", async () => {
    const providerResponse = "github failure contains a secret provider body";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(providerResponse, { status: 422 })),
    );

    const error = await submitGitHubComment(
      "installation-token",
      buildNoFindingsComment({
        repositoryFullName: "acme/review",
        pullRequestNumber: 17,
        commitId: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "GitHubApiError", status: 422 });
    expect(JSON.stringify(error)).not.toContain(providerResponse);
  });

  it("rejects a forged or unsafe descriptor before calling GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const forged = { ...inlineRequest, endpoint: "https://attacker.example/comment" };

    const error = await submitGitHubComment("installation-token", forged).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "INVALID_COMMENT_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
