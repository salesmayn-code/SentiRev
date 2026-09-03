import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RepositoryAuthorizationError,
  requireRepositoryAdmin,
} from "@/lib/auth/authorization";
import { GitHubApiError } from "@/lib/github/client";

const session = {
  userId: "user-1",
  githubUserId: "42",
  githubLogin: "octocat",
  accessToken: "oauth-token-for-test-only",
  expiresAt: Date.now() + 60_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("repository administrator authorization", () => {
  it("allows a repository only when GitHub currently confirms admin permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id: 123,
          name: "demo",
          full_name: "acme/demo",
          owner: { login: "acme" },
          permissions: { admin: true },
        }),
      ),
    );

    await expect(requireRepositoryAdmin(session, "acme/demo")).resolves.toMatchObject({
      full_name: "acme/demo",
    });
  });

  it("denies a visible repository when the user is not its administrator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          id: 123,
          name: "demo",
          full_name: "acme/demo",
          owner: { login: "acme" },
          permissions: { admin: false },
        }),
      ),
    );

    await expect(requireRepositoryAdmin(session, "acme/demo")).rejects.toBeInstanceOf(
      RepositoryAuthorizationError,
    );
  });

  it("does not misreport a GitHub outage as a non-admin decision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(requireRepositoryAdmin(session, "acme/demo")).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});
