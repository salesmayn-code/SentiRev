import { ReviewFeedbackStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  processOperationalReview,
  type OperationalReviewDependencies,
} from "@/lib/review/operational";
import type { ReviewServiceDependencies } from "@/lib/review/service";

const headSha = "0123456789abcdef0123456789abcdef01234567";

function baseDependencies(): OperationalReviewDependencies {
  return {
    loadJob: vi.fn().mockResolvedValue({
      id: "job-1",
      pullRequest: {
        githubNumber: 17,
        headSha,
        repository: {
          fullName: "acme/review",
          consent: { mode: "STATIC_ONLY" },
          installation: { githubInstallationId: "42" },
        },
      },
    }),
    createInstallationToken: vi.fn().mockResolvedValue("installation-token"),
    fetchDiff: vi.fn().mockResolvedValue("diff --git a/src/auth.ts b/src/auth.ts\n"),
    runtime: () => ({}) as ReviewServiceDependencies,
    createDelivery: vi.fn().mockImplementation(async (input) => ({
      id: `delivery-${input.kind}-${input.findingId ?? "outcome"}`,
      status: ReviewFeedbackStatus.PENDING,
    })),
    submit: vi.fn().mockImplementation(async (_token, request) => ({
      accepted: true as const,
      status: 201,
      idempotencyKey: request.idempotencyKey,
      githubCommentId: 123,
    })),
    markPosted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}

const storedFinding = {
  id: "finding-1",
  filePath: "src/auth.ts",
  startLine: 24,
  endLine: 24,
  severity: "High" as const,
  category: "authorization-bypass",
  fingerprint: "stable-fingerprint",
  summary: "The privileged export lacks an administrator check.",
  reasoning: "Authentication alone does not authorize an administrative export.",
  snippet: "if (user) return exportReport(user.id);",
  provenance: [{
    engineKind: "STATIC" as const,
    engineIdentifier: "semgrep@1.176.0",
    staticRuleId: "sentirev.authorization-bypass",
  }],
};

describe("Phase 004 operational review runtime", () => {
  it("posts cited findings and one delayed notice for a partial review", async () => {
    const dependencies = baseDependencies();
    dependencies.execute = vi.fn().mockResolvedValue({
      status: "PARTIAL",
      findingCount: 1,
      replayed: false,
    });
    dependencies.loadFindings = vi.fn().mockResolvedValue([storedFinding]);

    const result = await processOperationalReview("job-1", dependencies);

    expect(result).toEqual({
      status: "PARTIAL",
      findingCount: 1,
      postedCount: 2,
      deliveryFailureCount: 0,
      replayed: false,
    });
    expect(dependencies.fetchDiff).toHaveBeenCalledWith(
      "installation-token",
      "acme/review",
      17,
    );
    expect(dependencies.submit).toHaveBeenCalledTimes(2);
    const submitted = (dependencies.submit as ReturnType<typeof vi.fn>).mock.calls;
    expect(submitted[0][1].endpoint).toBe("/repos/acme/review/pulls/17/comments");
    expect(submitted[0][1].payload.body).toContain("**Severity: High**");
    expect(submitted[1][1].endpoint).toBe("/repos/acme/review/issues/17/comments");
    expect(submitted[1][1].payload.body).toContain("Review delayed.");
  });

  it("posts the explicit no-findings outcome and treats an existing delivery as replay", async () => {
    const first = baseDependencies();
    first.execute = vi.fn().mockResolvedValue({
      status: "COMPLETED",
      findingCount: 0,
      replayed: false,
    });
    first.loadFindings = vi.fn().mockResolvedValue([]);

    await expect(processOperationalReview("job-1", first)).resolves.toMatchObject({
      status: "COMPLETED",
      postedCount: 1,
    });
    expect(first.submit).toHaveBeenCalledWith(
      "installation-token",
      expect.objectContaining({ payload: { body: expect.stringContaining("No findings") } }),
    );

    const replay = baseDependencies();
    replay.execute = vi.fn().mockResolvedValue({
      status: "COMPLETED",
      findingCount: 0,
      replayed: true,
    });
    replay.loadFindings = vi.fn().mockResolvedValue([]);
    replay.createDelivery = vi.fn().mockResolvedValue({
      id: "existing-no-findings",
      status: ReviewFeedbackStatus.POSTED,
    });

    await expect(processOperationalReview("job-1", replay)).resolves.toMatchObject({
      replayed: true,
      postedCount: 0,
      deliveryFailureCount: 0,
    });
    expect(replay.submit).not.toHaveBeenCalled();
  });

  it("records a failed feedback delivery without retrying or hiding the review result", async () => {
    const dependencies = baseDependencies();
    dependencies.execute = vi.fn().mockResolvedValue({
      status: "COMPLETED",
      findingCount: 1,
      replayed: false,
    });
    dependencies.loadFindings = vi.fn().mockResolvedValue([storedFinding]);
    dependencies.submit = vi.fn().mockRejectedValue(new Error("GitHub body must not persist"));

    await expect(processOperationalReview("job-1", dependencies)).resolves.toMatchObject({
      status: "COMPLETED",
      postedCount: 0,
      deliveryFailureCount: 1,
    });
    expect(dependencies.markFailed).toHaveBeenCalledTimes(1);
    expect(dependencies.submit).toHaveBeenCalledTimes(1);
  });
});
