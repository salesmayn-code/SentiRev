import {
  JobStatus,
  ReviewFeedbackKind,
  ReviewFeedbackStatus,
} from "@prisma/client";

import {
  createInstallationToken,
  getPullRequestDiff,
  submitGitHubComment,
  type GitHubCommentAcknowledgement,
} from "@/lib/github/client";
import {
  buildDelayedReviewComment,
  buildFailedReviewComment,
  buildInlineReviewComment,
  buildNoFindingsComment,
  type GitHubCommentRequest,
} from "@/lib/github/review-feedback";
import { prisma } from "@/lib/db/client";
import {
  createOwnerManagedReviewRuntime,
  createReviewRuntime,
} from "@/lib/review/runtime";
import { executeReview, type ReviewServiceDependencies } from "@/lib/review/service";
import { parseReviewFinding, type ReviewFinding } from "@/lib/review/schema";

const MAX_PULL_REQUEST_DIFF_BYTES = 2 * 1024 * 1024;

type OperationalJob = {
  id: string;
  pullRequest: {
    githubNumber: number;
    headSha: string;
    repository: {
      fullName: string;
      consent: { mode: "AI_ALLOWED" | "STATIC_ONLY" } | null;
      installation: { githubInstallationId: string };
    };
  };
};

type StoredFinding = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  severity: "Critical" | "High" | "Medium" | "Low";
  category: string;
  fingerprint: string;
  summary: string;
  reasoning: string;
  snippet: string;
  provenance: Array<{
    engineKind: "STATIC" | "AI";
    engineIdentifier: string;
    staticRuleId: string | null;
  }>;
};

export type OperationalReviewDependencies = {
  loadJob?: (foundationJobId: string) => Promise<OperationalJob | null>;
  createInstallationToken?: (installationId: number) => Promise<string>;
  fetchDiff?: (
    installationToken: string,
    repositoryFullName: string,
    pullRequestNumber: number,
  ) => Promise<string>;
  runtime?: () => ReviewServiceDependencies;
  execute?: typeof executeReview;
  loadFindings?: (foundationJobId: string) => Promise<StoredFinding[]>;
  createDelivery?: (
    input: CreateDeliveryInput,
  ) => Promise<{ id: string; status: ReviewFeedbackStatus }>;
  submit?: (
    installationToken: string,
    request: GitHubCommentRequest<unknown>,
  ) => Promise<GitHubCommentAcknowledgement>;
  markPosted?: (deliveryId: string, acknowledgement: GitHubCommentAcknowledgement) => Promise<void>;
  markFailed?: (deliveryId: string, error: unknown) => Promise<void>;
  markReviewFailed?: (foundationJobId: string) => Promise<void>;
};

type CreateDeliveryInput = {
  foundationJobId: string;
  findingId?: string;
  kind: ReviewFeedbackKind;
  idempotencyKey: string;
};

export type OperationalReviewResult = {
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  findingCount: number;
  postedCount: number;
  deliveryFailureCount: number;
  replayed: boolean;
};

function runtimeForConsent(
  consent: "AI_ALLOWED" | "STATIC_ONLY",
  dependencies: OperationalReviewDependencies,
): ReviewServiceDependencies {
  if (dependencies.runtime) return dependencies.runtime();
  // The static-only path never calls the AI runner. Supplying no provider key
  // here avoids treating owner-key absence as a static-analysis failure.
  return consent === "STATIC_ONLY"
    ? createReviewRuntime("")
    : createOwnerManagedReviewRuntime();
}

async function markReviewFailed(foundationJobId: string): Promise<void> {
  await prisma.foundationJob.updateMany({
    where: { id: foundationJobId, status: JobStatus.RUNNING },
    data: { status: JobStatus.FAILED, completedAt: new Date(), failureReason: "review_failed" },
  });
}

function safeGitHubErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isSafeInteger(status)) {
      return `github_${status}`;
    }
  }
  return "github_delivery_failed";
}

function asFinding(value: StoredFinding): ReviewFinding {
  return parseReviewFinding({
    filePath: value.filePath,
    startLine: value.startLine,
    endLine: value.endLine,
    severity: value.severity,
    category: value.category,
    summary: value.summary,
    reasoning: value.reasoning,
    snippet: value.snippet,
    provenance: value.provenance.map((provenance) => ({
      engineKind: provenance.engineKind,
      engineIdentifier: provenance.engineIdentifier,
      ...(provenance.staticRuleId ? { staticRuleId: provenance.staticRuleId } : {}),
    })),
  });
}

async function loadOperationalJob(foundationJobId: string): Promise<OperationalJob | null> {
  return prisma.foundationJob.findUnique({
    where: { id: foundationJobId },
    select: {
      id: true,
      pullRequest: {
        select: {
          githubNumber: true,
          headSha: true,
          repository: {
            select: {
              fullName: true,
              consent: { select: { mode: true } },
              installation: { select: { githubInstallationId: true } },
            },
          },
        },
      },
    },
  });
}

async function loadStoredFindings(foundationJobId: string): Promise<StoredFinding[]> {
  return prisma.finding.findMany({
    where: { foundationJobId },
    orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
    select: {
      id: true,
      filePath: true,
      startLine: true,
      endLine: true,
      severity: true,
      category: true,
      fingerprint: true,
      summary: true,
      reasoning: true,
      snippet: true,
      provenance: {
        select: { engineKind: true, engineIdentifier: true, staticRuleId: true },
        orderBy: { engineIdentifier: "asc" },
      },
    },
  });
}

async function createReviewDelivery(input: CreateDeliveryInput) {
  return prisma.reviewCommentDelivery.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: {
      foundationJobId: input.foundationJobId,
      ...(input.findingId ? { findingId: input.findingId } : {}),
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true, status: true },
  });
}

async function markReviewDeliveryPosted(
  deliveryId: string,
  acknowledgement: GitHubCommentAcknowledgement,
): Promise<void> {
  await prisma.reviewCommentDelivery.update({
    where: { id: deliveryId },
    data: {
      status: ReviewFeedbackStatus.POSTED,
      githubCommentId: acknowledgement.githubCommentId?.toString(),
      postedAt: new Date(),
      errorCode: null,
    },
  });
}

async function markReviewDeliveryFailed(deliveryId: string, error: unknown): Promise<void> {
  await prisma.reviewCommentDelivery.update({
    where: { id: deliveryId },
    data: {
      status: ReviewFeedbackStatus.FAILED,
      errorCode: safeGitHubErrorCode(error),
    },
  });
}

async function postDelivery(
  installationToken: string,
  request: GitHubCommentRequest<unknown>,
  input: Omit<CreateDeliveryInput, "idempotencyKey">,
  dependencies: OperationalReviewDependencies,
): Promise<"posted" | "failed" | "already_posted"> {
  const delivery = await (dependencies.createDelivery ?? createReviewDelivery)({
    ...input,
    idempotencyKey: request.idempotencyKey,
  });
  if (delivery.status === ReviewFeedbackStatus.POSTED) return "already_posted";
  if (delivery.status === ReviewFeedbackStatus.FAILED) return "failed";

  try {
    const acknowledgement = await (dependencies.submit ?? submitGitHubComment)(
      installationToken,
      request,
    );
    await (dependencies.markPosted ?? markReviewDeliveryPosted)(delivery.id, acknowledgement);
    return "posted";
  } catch (error) {
    await (dependencies.markFailed ?? markReviewDeliveryFailed)(delivery.id, error);
    return "failed";
  }
}

function terminalFeedback(
  status: "COMPLETED" | "PARTIAL" | "FAILED",
  findingCount: number,
  repositoryFullName: string,
  pullRequestNumber: number,
  headSha: string,
): { kind: ReviewFeedbackKind; request: GitHubCommentRequest<unknown> } | null {
  const input = { repositoryFullName, pullRequestNumber, commitId: headSha };
  if (status === "FAILED") {
    return { kind: ReviewFeedbackKind.FAILED, request: buildFailedReviewComment(input) };
  }
  if (status === "PARTIAL") {
    return { kind: ReviewFeedbackKind.DELAYED, request: buildDelayedReviewComment(input) };
  }
  if (findingCount === 0) {
    return { kind: ReviewFeedbackKind.NO_FINDINGS, request: buildNoFindingsComment(input) };
  }
  return null;
}

/**
 * Runs an already-queued review job through bounded GitHub diff retrieval,
 * the accepted review service, and durable feedback delivery. All external
 * boundaries are injectable for tests; the raw diff remains only in memory.
 */
export async function processOperationalReview(
  foundationJobId: string,
  dependencies: OperationalReviewDependencies = {},
): Promise<OperationalReviewResult> {
  const job = await (dependencies.loadJob ?? loadOperationalJob)(foundationJobId);
  if (!job) throw new Error("Operational review job was not found");
  const installationId = Number(job.pullRequest.repository.installation.githubInstallationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("Operational review installation reference is invalid");
  }

  const installationToken = await (dependencies.createInstallationToken ?? createInstallationToken)(
    installationId,
  );
  let rawDiff: string;
  try {
    rawDiff = await (dependencies.fetchDiff ?? ((token, repositoryFullName, pullRequestNumber) =>
      getPullRequestDiff(token, repositoryFullName, pullRequestNumber, {
        maxBytes: MAX_PULL_REQUEST_DIFF_BYTES,
      })))(
        installationToken,
        job.pullRequest.repository.fullName,
        job.pullRequest.githubNumber,
      );
  } catch {
    await (dependencies.markReviewFailed ?? markReviewFailed)(foundationJobId);
    const failedOutcome = terminalFeedback(
      "FAILED",
      0,
      job.pullRequest.repository.fullName,
      job.pullRequest.githubNumber,
      job.pullRequest.headSha,
    )!;
    const delivery = await postDelivery(
      installationToken,
      failedOutcome.request,
      { foundationJobId, kind: failedOutcome.kind },
      dependencies,
    );
    return {
      status: "FAILED",
      findingCount: 0,
      postedCount: delivery === "posted" ? 1 : 0,
      deliveryFailureCount: delivery === "failed" ? 1 : 0,
      replayed: false,
    };
  }

  const consent = job.pullRequest.repository.consent?.mode ?? "STATIC_ONLY";
  let result: { status: "COMPLETED" | "PARTIAL" | "FAILED"; findingCount: number; replayed: boolean };
  try {
    result = await (dependencies.execute ?? executeReview)(
      { foundationJobId, rawDiff, consent },
      runtimeForConsent(consent, dependencies),
    );
  } catch {
    await (dependencies.markReviewFailed ?? markReviewFailed)(foundationJobId);
    result = { status: "FAILED", findingCount: 0, replayed: false };
  }
  const findings = await (dependencies.loadFindings ?? loadStoredFindings)(foundationJobId);
  let postedCount = 0;
  let deliveryFailureCount = 0;

  for (const storedFinding of findings) {
    const delivery = await postDelivery(
      installationToken,
      buildInlineReviewComment({
        repositoryFullName: job.pullRequest.repository.fullName,
        pullRequestNumber: job.pullRequest.githubNumber,
        commitId: job.pullRequest.headSha,
        finding: asFinding(storedFinding),
      }),
      {
        foundationJobId,
        findingId: storedFinding.id,
        kind: ReviewFeedbackKind.FINDING,
      },
      dependencies,
    );
    if (delivery === "posted") postedCount += 1;
    if (delivery === "failed") deliveryFailureCount += 1;
  }

  const outcome = terminalFeedback(
    result.status,
    findings.length,
    job.pullRequest.repository.fullName,
    job.pullRequest.githubNumber,
    job.pullRequest.headSha,
  );
  if (outcome) {
    const delivery = await postDelivery(
      installationToken,
      outcome.request,
      { foundationJobId, kind: outcome.kind },
      dependencies,
    );
    if (delivery === "posted") postedCount += 1;
    if (delivery === "failed") deliveryFailureCount += 1;
  }

  return {
    status: result.status,
    findingCount: findings.length,
    postedCount,
    deliveryFailureCount,
    replayed: result.replayed,
  };
}

export async function markOperationalJobCompleted(foundationJobId: string): Promise<void> {
  await prisma.foundationJob.updateMany({
    where: { id: foundationJobId, status: JobStatus.RUNNING },
    data: { status: JobStatus.COMPLETED, completedAt: new Date() },
  });
}
