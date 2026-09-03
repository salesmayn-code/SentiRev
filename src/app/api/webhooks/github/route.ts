import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db/client";
import { getServerEnvironment } from "@/lib/env";
import { createFoundationOutboxJob, publishQueuedFoundationJob } from "@/lib/queue/outbox";
import { verifyGitHubWebhookSignature } from "@/lib/security/webhook";

export const runtime = "nodejs";

const pullRequestEventSchema = z.object({
  action: z.enum(["opened", "synchronize"]),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)]),
    name: z.string().min(1).max(200),
    full_name: z.string().regex(/^[^/]+\/[^/]+$/u),
    owner: z.object({ login: z.string().min(1).max(200) }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string().min(1).max(200) }),
  }),
});

type DeliveryResult = {
  foundationJobId: string;
  duplicate: boolean;
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

async function existingDeliveryResult(
  githubDeliveryId: string,
): Promise<DeliveryResult | null> {
  const existingDelivery = await prisma.webhookDelivery.findUnique({
    where: { githubDeliveryId },
    select: { id: true, job: { select: { id: true } } },
  });
  if (!existingDelivery?.job) {
    return null;
  }
  return { foundationJobId: existingDelivery.job.id, duplicate: true };
}

export async function POST(request: Request): Promise<NextResponse> {
  const environment = getServerEnvironment();
  let rawBody: Uint8Array;
  try {
    rawBody = new Uint8Array(await request.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (
    !verifyGitHubWebhookSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
      environment.SENTIREV_GITHUB_WEBHOOK_SECRET,
    )
  ) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  if (request.headers.get("x-github-event") !== "pull_request") {
    return NextResponse.json({ accepted: true, ignored: true });
  }

  const githubDeliveryId = request.headers.get("x-github-delivery");
  if (!githubDeliveryId || githubDeliveryId.length > 255) {
    return NextResponse.json({ error: "missing_delivery_id" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = pullRequestEventSchema.safeParse(payload);
  if (!parsed.success) {
    const action =
      typeof payload === "object" && payload !== null && "action" in payload
        ? payload.action
        : undefined;
    if (action === "closed" || action === "reopened" || action === "edited") {
      return NextResponse.json({ accepted: true, ignored: true });
    }
    return NextResponse.json({ error: "invalid_pull_request_event" }, { status: 400 });
  }

  const event = parsed.data;
  const repositoryId = String(event.repository.id);
  const repository = await prisma.repository.findUnique({
    where: { fullName: event.repository.full_name },
    select: {
      id: true,
      githubRepositoryId: true,
      ownerLogin: true,
      name: true,
      installation: { select: { githubInstallationId: true } },
      connectionStatus: true,
    },
  });

  if (
    !repository ||
    repository.githubRepositoryId !== repositoryId ||
    repository.ownerLogin !== event.repository.owner.login ||
    repository.name !== event.repository.name ||
    repository.installation.githubInstallationId !== String(event.installation.id) ||
    repository.connectionStatus !== "CONNECTED"
  ) {
    return NextResponse.json({ error: "repository_not_connected" }, { status: 404 });
  }

  const createDelivery = async (): Promise<DeliveryResult> =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.webhookDelivery.findUnique({
        where: { githubDeliveryId },
        select: { id: true, job: { select: { id: true } } },
      });
      if (existing?.job) {
        return { foundationJobId: existing.job.id, duplicate: true };
      }
      if (existing) {
        throw new Error("delivery_missing_job");
      }

      const pullRequest = await tx.pullRequest.upsert({
        where: {
          repositoryId_githubNumber_headSha: {
            repositoryId: repository.id,
            githubNumber: event.pull_request.number,
            headSha: event.pull_request.head.sha,
          },
        },
        update: {},
        create: {
          repositoryId: repository.id,
          githubNumber: event.pull_request.number,
          headSha: event.pull_request.head.sha,
        },
        select: { id: true },
      });
      const delivery = await tx.webhookDelivery.create({
        data: {
          githubDeliveryId,
          event: "pull_request",
          action: event.action,
          repositoryId: repository.id,
          pullRequestId: pullRequest.id,
        },
        select: { id: true },
      });
      const foundationJob = await createFoundationOutboxJob(tx, {
        webhookDeliveryId: delivery.id,
        pullRequestId: pullRequest.id,
        idempotencyKey: `github:${githubDeliveryId}`,
      });
      return { foundationJobId: foundationJob.id, duplicate: false };
    });

  let result: DeliveryResult | null = null;
  try {
    result = await createDelivery();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      result = await existingDeliveryResult(githubDeliveryId);
    }
    if (!result) {
      return NextResponse.json({ error: "delivery_persistence_failed" }, { status: 503 });
    }
  }

  try {
    await publishQueuedFoundationJob(result.foundationJobId);
  } catch {
    return NextResponse.json({ error: "job_enqueue_failed" }, { status: 503 });
  }

  return NextResponse.json(
    {
      accepted: true,
      duplicate: result.duplicate,
      jobId: result.foundationJobId,
    },
    { status: 202 },
  );
}
