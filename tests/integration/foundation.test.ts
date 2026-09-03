import { createHmac } from "node:crypto";

import { ConsentMode, JobStatus } from "@prisma/client";
import type { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as receiveGitHubWebhook } from "@/app/api/webhooks/github/route";
import { prisma } from "@/lib/db/client";
import { closeRedisConnection } from "@/lib/queue/connection";
import {
  closeFoundationQueue,
  getFoundationQueue,
  type FoundationQueuePayload,
} from "@/lib/queue/foundation";
import { startFoundationWorker } from "@/lib/queue/worker";

const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const numericRunId = String(Date.now()).slice(-11);
const installationGithubId = `${numericRunId}1`;
const repositoryGithubId = `${numericRunId}2`;
const staticRepositoryGithubId = `${numericRunId}3`;
const repositoryFullName = `sentirev-phase-001-${runId}/integration-ai`;
const staticRepositoryFullName = `sentirev-phase-001-${runId}/integration-static`;
const createdJobIds: string[] = [];

let userId = "";
let installationId = "";
let repositoryId = "";
let staticRepositoryId = "";
let worker: Worker<FoundationQueuePayload> | undefined;

function signature(body: string): string {
  return `sha256=${createHmac("sha256", process.env.SENTIREV_GITHUB_WEBHOOK_SECRET!)
    .update(body)
    .digest("hex")}`;
}

function pullRequestBody(action: "opened" | "synchronize", headSha: string) {
  const [owner, name] = repositoryFullName.split("/");
  return JSON.stringify({
    action,
    installation: { id: Number(installationGithubId) },
    repository: {
      id: Number(repositoryGithubId),
      name,
      full_name: repositoryFullName,
      owner: { login: owner },
    },
    pull_request: { number: 17, head: { sha: headSha } },
  });
}

async function deliver(
  deliveryId: string,
  body: string,
  signatureHeader = signature(body),
): Promise<Response> {
  return receiveGitHubWebhook(
    new Request("http://localhost:3000/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
        "x-hub-signature-256": signatureHeader,
      },
      body,
    }),
  );
}

async function waitForJob(
  foundationJobId: string,
  predicate: (status: JobStatus) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.foundationJob.findUniqueOrThrow({
      where: { id: foundationJobId },
    });
    if (predicate(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for foundation job ${foundationJobId}`);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      githubUserId: `phase-001-${runId}`,
      login: `phase-001-${runId}`,
    },
  });

  userId = user.id;
  await prisma.$transaction(async (tx) => {
    const installation = await tx.installation.create({
      data: { githubInstallationId: installationGithubId, ownerUserId: userId },
    });
    installationId = installation.id;
    const repository = await tx.repository.create({
      data: {
        githubRepositoryId: repositoryGithubId,
        ownerLogin: repositoryFullName.split("/")[0],
        name: repositoryFullName.split("/")[1],
        fullName: repositoryFullName,
        installationId,
        consent: {
          create: { mode: ConsentMode.AI_ALLOWED, recordedById: userId },
        },
      },
    });
    repositoryId = repository.id;
    const staticRepository = await tx.repository.create({
      data: {
        githubRepositoryId: staticRepositoryGithubId,
        ownerLogin: staticRepositoryFullName.split("/")[0],
        name: staticRepositoryFullName.split("/")[1],
        fullName: staticRepositoryFullName,
        installationId,
        consent: {
          create: { mode: ConsentMode.STATIC_ONLY, recordedById: userId },
        },
      },
    });
    staticRepositoryId = staticRepository.id;
  });
});

afterAll(async () => {
  await worker?.close();
  const queue = getFoundationQueue();
  for (const jobId of createdJobIds) {
    const job = await queue.getJob(jobId);
    await job?.remove();
  }
  await closeFoundationQueue();
  await closeRedisConnection();

  if (repositoryId || staticRepositoryId) {
    const repositoryIds = [repositoryId, staticRepositoryId].filter(Boolean);
    await prisma.finding.deleteMany({
      where: { foundationJob: { pullRequest: { repositoryId: { in: repositoryIds } } } },
    });
    await prisma.foundationJob.deleteMany({
      where: { pullRequest: { repositoryId: { in: repositoryIds } } },
    });
    await prisma.webhookDelivery.deleteMany({
      where: { repositoryId: { in: repositoryIds } },
    });
    await prisma.pullRequest.deleteMany({
      where: { repositoryId: { in: repositoryIds } },
    });
    await prisma.repositoryConsent.deleteMany({
      where: { repositoryId: { in: repositoryIds } },
    });
    await prisma.repository.deleteMany({ where: { id: { in: repositoryIds } } });
  }
  if (installationId) {
    await prisma.installation.delete({ where: { id: installationId } });
  }
  if (userId) {
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe.sequential("PostgreSQL, signed webhook, and Redis worker boundary", () => {
  it("persists both auditable connection-time consent modes", async () => {
    const consents = await prisma.repositoryConsent.findMany({
      where: { repositoryId: { in: [repositoryId, staticRepositoryId] } },
      orderBy: { mode: "asc" },
    });

    expect(consents.map(({ mode }) => mode).sort()).toEqual([
      ConsentMode.AI_ALLOWED,
      ConsentMode.STATIC_ONLY,
    ]);
    expect(consents.every(({ recordedAt, recordedById }) =>
      recordedAt instanceof Date && recordedById === userId,
    )).toBe(true);
  });

  it("rejects an invalid raw-body signature without persistence or enqueueing", async () => {
    const deliveryId = `phase-001-invalid-${runId}`;
    const before = await prisma.webhookDelivery.count();
    const response = await deliver(
      deliveryId,
      pullRequestBody("opened", `invalid-${runId}`),
      `sha256=${"0".repeat(64)}`,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
    expect(await prisma.webhookDelivery.count()).toBe(before);
    expect(await getFoundationQueue().getJob(deliveryId)).toBeUndefined();
  });

  it("moves a valid opened delivery through queued, running, and completed", async () => {
    const deliveryId = `phase-001-opened-${runId}`;
    const response = await deliver(
      deliveryId,
      pullRequestBody("opened", `opened-${runId}`),
    );
    const responseBody = (await response.json()) as {
      accepted: boolean;
      duplicate: boolean;
      jobId: string;
    };
    createdJobIds.push(responseBody.jobId);

    expect(response.status).toBe(202);
    expect(responseBody).toMatchObject({ accepted: true, duplicate: false });
    expect(
      await prisma.foundationJob.findUniqueOrThrow({ where: { id: responseBody.jobId } }),
    ).toMatchObject({ status: JobStatus.QUEUED, attempts: 0 });
    expect(await getFoundationQueue().getJob(responseBody.jobId)).toBeDefined();

    worker = await startFoundationWorker({
      beforeComplete: async (payload, attemptNumber) => {
        const row = await prisma.foundationJob.findUniqueOrThrow({
          where: { id: payload.foundationJobId },
          select: { webhookDelivery: { select: { action: true } } },
        });
        if (row.webhookDelivery.action === "opened") {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (row.webhookDelivery.action === "synchronize" && attemptNumber === 1) {
          throw new Error("phase-001 simulated transient failure");
        }
      },
    });
    await worker.waitUntilReady();

    const running = await waitForJob(responseBody.jobId, (status) => status === JobStatus.RUNNING);
    expect(running.attempts).toBe(1);
    const completed = await waitForJob(
      responseBody.jobId,
      (status) => status === JobStatus.COMPLETED,
    );
    expect(completed).toMatchObject({ status: JobStatus.COMPLETED, attempts: 1 });
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.queuePublishedAt).toBeInstanceOf(Date);
  });

  it("records a transient failure and completes a synchronize delivery on retry", async () => {
    const deliveryId = `phase-001-synchronize-${runId}`;
    const response = await deliver(
      deliveryId,
      pullRequestBody("synchronize", `synchronize-${runId}`),
    );
    const responseBody = (await response.json()) as { jobId: string; duplicate: boolean };
    createdJobIds.push(responseBody.jobId);

    expect(response.status).toBe(202);
    expect(responseBody.duplicate).toBe(false);
    const failed = await waitForJob(
      responseBody.jobId,
      (status) => status === JobStatus.FAILED,
    );
    expect(failed.failureReason).toBe("phase-001 simulated transient failure");

    const completed = await waitForJob(
      responseBody.jobId,
      (status) => status === JobStatus.COMPLETED,
    );
    expect(completed).toMatchObject({ status: JobStatus.COMPLETED, attempts: 2 });
    expect(completed.failureReason).toBeNull();
  });

  it("replays a delivery without creating another pull request, delivery, or job", async () => {
    const deliveryId = `phase-001-opened-${runId}`;
    const body = pullRequestBody("opened", `opened-${runId}`);
    const before = {
      pullRequests: await prisma.pullRequest.count({ where: { repositoryId } }),
      deliveries: await prisma.webhookDelivery.count({ where: { repositoryId } }),
      jobs: await prisma.foundationJob.count({
        where: { pullRequest: { repositoryId } },
      }),
    };
    const response = await deliver(deliveryId, body);
    const responseBody = (await response.json()) as { duplicate: boolean; jobId: string };

    expect(response.status).toBe(202);
    expect(responseBody.duplicate).toBe(true);
    expect({
      pullRequests: await prisma.pullRequest.count({ where: { repositoryId } }),
      deliveries: await prisma.webhookDelivery.count({ where: { repositoryId } }),
      jobs: await prisma.foundationJob.count({
        where: { pullRequest: { repositoryId } },
      }),
    }).toEqual(before);
    expect(
      await prisma.foundationJob.findUniqueOrThrow({ where: { id: responseBody.jobId } }),
    ).toMatchObject({ status: JobStatus.COMPLETED, attempts: 1 });
  });
});
