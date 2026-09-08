import { ReviewFeedbackStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  processOperationalReview,
  type OperationalReviewDependencies,
} from "@/lib/review/operational";
import type { ReviewServiceDependencies } from "@/lib/review/service";

describe("Phase 004 operational review privacy", () => {
  it("turns a review-runtime failure into one safe failed outcome without exposing the raw diff", async () => {
    const rawDiff = "diff --git a/src/secret.ts b/src/secret.ts\n+PRIVATE_OWNER_SECRET=do-not-retain\n";
    const markReviewFailed = vi.fn().mockResolvedValue(undefined);
    const submit = vi.fn().mockResolvedValue({
      accepted: true as const,
      status: 201,
      idempotencyKey: "sentirev:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const dependencies: OperationalReviewDependencies = {
      loadJob: vi.fn().mockResolvedValue({
        id: "job-privacy",
        pullRequest: {
          githubNumber: 7,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          repository: {
            fullName: "acme/review",
            consent: { mode: "AI_ALLOWED" },
            installation: { githubInstallationId: "42" },
          },
        },
      }),
      createInstallationToken: vi.fn().mockResolvedValue("installation-token"),
      fetchDiff: vi.fn().mockResolvedValue(rawDiff),
      runtime: () => {
        throw new Error("owner provider key unavailable");
      },
      execute: vi.fn(),
      loadFindings: vi.fn().mockResolvedValue([]),
      createDelivery: vi.fn().mockResolvedValue({
        id: "failed-delivery",
        status: ReviewFeedbackStatus.PENDING,
      }),
      submit,
      markPosted: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      markReviewFailed,
    };

    const result = await processOperationalReview("job-privacy", dependencies);

    expect(result).toMatchObject({ status: "FAILED", findingCount: 0, postedCount: 1 });
    expect(markReviewFailed).toHaveBeenCalledWith("job-privacy");
    expect(submit).toHaveBeenCalledWith(
      "installation-token",
      expect.objectContaining({
        endpoint: "/repos/acme/review/issues/7/comments",
        payload: { body: expect.stringContaining("Review failed.") },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OWNER_SECRET");
    expect(JSON.stringify(submit.mock.calls)).not.toContain("PRIVATE_OWNER_SECRET");
  });
});
