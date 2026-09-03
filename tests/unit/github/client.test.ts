import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getGitHubAppInstallUrl,
  getRepositoryForUser,
  isRepositoryAdmin,
} from "../../../src/lib/github/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub client boundary", () => {
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
});
