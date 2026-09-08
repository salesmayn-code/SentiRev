import { ConsentMode, JobStatus } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/client";
import { parseUnifiedDiff } from "@/lib/review/diff";
import { executeReview, type ReviewChunk } from "@/lib/review/service";
import { createReviewRuntime } from "@/lib/review/runtime";
import { parseReviewFinding } from "@/lib/review/schema";
import { runSemgrep } from "@/lib/review/static";
import { PRIMARY_MODEL } from "@/lib/review/providers/openrouter";

const runId = `phase-003-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let installationId = "";
let repositoryId = "";

const chunks: ReviewChunk[] = [{
  filePath: "src/auth/check.ts",
  text: "if (user) return exportReport(user.id);",
  changedNewLines: [24],
}];

function finding(engine: "STATIC" | "AI") {
  return parseReviewFinding({
    filePath: "src/auth/check.ts",
    startLine: 24,
    endLine: 24,
    severity: engine === "AI" ? "High" : "Medium",
    category: "authorization-bypass",
    summary: "Privileged export lacks an admin role check.",
    reasoning: "Authentication alone does not authorize an administrative export.",
    snippet: "if (user) return exportReport(user.id);",
    provenance: engine === "STATIC"
      ? [{ engineKind: "STATIC", engineIdentifier: "semgrep", staticRuleId: "sentirev.authorization-bypass" }]
      : [{ engineKind: "AI", engineIdentifier: PRIMARY_MODEL }],
  });
}

async function createJob(consent: ConsentMode = ConsentMode.AI_ALLOWED) {
  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId,
      githubNumber: Math.floor(Math.random() * 1_000_000),
      headSha: `${runId}-${Math.random()}`,
    },
  });
  const delivery = await prisma.webhookDelivery.create({
    data: {
      githubDeliveryId: `${runId}-${Math.random()}`,
      event: "pull_request",
      action: "opened",
      repositoryId,
      pullRequestId: pullRequest.id,
    },
  });
  await prisma.repositoryConsent.update({ where: { repositoryId }, data: { mode: consent } });
  return prisma.foundationJob.create({
    data: {
      webhookDeliveryId: delivery.id,
      pullRequestId: pullRequest.id,
      idempotencyKey: `${runId}-${Math.random()}`,
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { githubUserId: runId, login: runId } });
  userId = user.id;
  const installation = await prisma.installation.create({
    data: { githubInstallationId: `${Date.now()}${Math.floor(Math.random() * 99)}`, ownerUserId: userId },
  });
  installationId = installation.id;
  const repository = await prisma.repository.create({
    data: {
      githubRepositoryId: `${Date.now()}${Math.floor(Math.random() * 99)}`,
      ownerLogin: "phase-003",
      name: runId,
      fullName: `phase-003/${runId}`,
      installationId,
      consent: { create: { mode: ConsentMode.AI_ALLOWED, recordedById: userId } },
    },
  });
  repositoryId = repository.id;
});

afterAll(async () => {
  await prisma.engineRun.deleteMany({ where: { foundationJob: { pullRequest: { repositoryId } } } });
  await prisma.finding.deleteMany({ where: { foundationJob: { pullRequest: { repositoryId } } } });
  await prisma.foundationJob.deleteMany({ where: { pullRequest: { repositoryId } } });
  await prisma.webhookDelivery.deleteMany({ where: { repositoryId } });
  await prisma.pullRequest.deleteMany({ where: { repositoryId } });
  await prisma.repositoryConsent.delete({ where: { repositoryId } });
  await prisma.repository.delete({ where: { id: repositoryId } });
  await prisma.installation.delete({ where: { id: installationId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe.sequential("Phase 003 review-service integration", () => {
  it("runs the phase-owned Semgrep rules on bounded JavaScript, TypeScript, and Python chunks", async () => {
    const sources = ["javascript-input.diff", "typescript-input.diff", "python-input.diff"]
      .map((name) => readFileSync(resolve("tests/fixtures/review", name), "utf8"));
    const parsed = sources.flatMap((source) => parseUnifiedDiff(source).chunks);
    const result = await runSemgrep(parsed);

    expect(result.semgrepVersion).toBe("1.176.0");
    expect(result.findings).toHaveLength(3);
    expect(result.findings.map((item) => item.category).sort()).toEqual([
      "code-execution",
      "command-injection",
      "unsafe-deserialization",
    ]);
    expect(result.findings.every((item) => item.provenance[0]?.engineIdentifier === "semgrep@1.176.0")).toBe(true);
  }, 70_000);

  it("executes the validated diff-to-static-to-persistence path without an AI call in static-only mode", async () => {
    const job = await createJob(ConsentMode.STATIC_ONLY);
    const rawDiff = readFileSync(resolve("tests/fixtures/review/javascript-input.diff"), "utf8");
    const result = await executeReview(
      { foundationJobId: job.id, rawDiff, consent: "STATIC_ONLY" },
      createReviewRuntime("synthetic-owner-key-not-used-in-static-only-mode"),
    );

    expect(result).toMatchObject({ status: "COMPLETED", findingCount: 1 });
    const stored = await prisma.foundationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { findings: { include: { provenance: true } }, engineRuns: true },
    });
    expect(stored.changedLineCount).toBe(2);
    expect(stored.outsideLatencyCohort).toBe(false);
    expect(stored.findings[0]).toMatchObject({ filePath: "src/review.js", startLine: 2, severity: "Critical" });
    expect(stored.engineRuns).toHaveLength(1);
    expect(stored.engineRuns[0]?.engineIdentifier).toBe("semgrep@1.176.0");
  }, 70_000);

  it("runs static and AI paths concurrently, deduplicates, persists provenance, and replays idempotently", async () => {
    const job = await createJob();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = executeReview({ foundationJobId: job.id, rawDiff: "synthetic-only", consent: "AI_ALLOWED" }, {
      parseDiff: vi.fn(() => chunks),
      runStatic: async () => { started.push("static"); await gate; return { path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "SUCCEEDED", durationMs: 3, findings: [finding("STATIC")] }; },
      runAi: async () => { started.push("ai"); await gate; return [{ path: "AI", engineKind: "AI", engineIdentifier: PRIMARY_MODEL, code: "SUCCEEDED", durationMs: 4, findings: [finding("AI")] }]; },
    });
    await vi.waitFor(() => expect(started.sort()).toEqual(["ai", "static"]));
    release();
    expect(await run).toMatchObject({ replayed: false, status: "COMPLETED", findingCount: 1 });

    const stored = await prisma.foundationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { findings: { include: { provenance: true } }, engineRuns: true },
    });
    expect(stored.status).toBe(JobStatus.COMPLETED);
    expect(stored.findings).toHaveLength(1);
    expect(stored.findings[0]).toMatchObject({ severity: "High", startLine: 24, endLine: 24 });
    expect(stored.findings[0].provenance).toHaveLength(2);
    expect(stored.engineRuns).toHaveLength(2);

    const replay = await executeReview({ foundationJobId: job.id, rawDiff: "different-but-not-stored", consent: "AI_ALLOWED" }, {
      parseDiff: () => { throw new Error("replay must not parse another diff"); },
      runStatic: async () => { throw new Error("replay must not run"); },
      runAi: async () => [],
    });
    expect(replay).toMatchObject({ replayed: true, status: "COMPLETED", findingCount: 1 });
  });

  it("enforces static-only consent and marks a valid zero result as completed", async () => {
    const job = await createJob(ConsentMode.STATIC_ONLY);
    const runAi = vi.fn();
    const result = await executeReview({ foundationJobId: job.id, rawDiff: "synthetic-only", consent: "STATIC_ONLY" }, {
      parseDiff: () => chunks,
      runStatic: async () => ({ path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "SUCCEEDED", durationMs: 1, findings: [] }),
      runAi,
    });
    expect(result).toMatchObject({ status: "COMPLETED", findingCount: 0 });
    expect(runAi).not.toHaveBeenCalled();
  });

  it("persists partial and failed terminal outcomes without dropping valid static results", async () => {
    const partialJob = await createJob();
    const partial = await executeReview({ foundationJobId: partialJob.id, rawDiff: "synthetic-only", consent: "AI_ALLOWED" }, {
      parseDiff: () => chunks,
      runStatic: async () => ({ path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "SUCCEEDED", durationMs: 1, findings: [finding("STATIC")] }),
      runAi: async () => [
        { path: "AI", engineKind: "AI", engineIdentifier: PRIMARY_MODEL, code: "TIMED_OUT", durationMs: 60_000, findings: [] },
      ],
    });
    expect(partial.status).toBe("PARTIAL");
    expect((await prisma.foundationJob.findUniqueOrThrow({ where: { id: partialJob.id } })).status).toBe(JobStatus.PARTIAL);

    const failedJob = await createJob();
    const failed = await executeReview({ foundationJobId: failedJob.id, rawDiff: "synthetic-only", consent: "AI_ALLOWED" }, {
      parseDiff: () => chunks,
      runStatic: async () => ({ path: "STATIC", engineKind: "STATIC", engineIdentifier: "semgrep", code: "FAILED", durationMs: 1, findings: [] }),
      runAi: async () => [{ path: "AI", engineKind: "AI", engineIdentifier: PRIMARY_MODEL, code: "INVALID", durationMs: 1, findings: [] }],
    });
    expect(failed.status).toBe("FAILED");
    expect((await prisma.foundationJob.findUniqueOrThrow({ where: { id: failedJob.id } })).failureReason).toBe("review_failed");
  });
});
