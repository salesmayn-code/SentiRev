import { EngineKind, EngineRunOutcome, FindingSeverity, JobStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import type { EngineExecution, ReviewOutcome } from "@/lib/review/outcomes";
import type { ReviewFinding } from "@/lib/review/schema";

export type PersistReviewInput = {
  foundationJobId: string;
  changedLineCount: number;
  outsideLatencyCohort: boolean;
  reviewDurationMs: number;
  outcome: ReviewOutcome;
  findings: ReviewFinding[];
  executions: EngineExecution[];
};

export type PersistReviewResult = {
  replayed: boolean;
  status: ReviewOutcome;
  findingCount: number;
};

function dbOutcome(code: EngineExecution["code"]): EngineRunOutcome {
  return EngineRunOutcome[code];
}

function dbKind(kind: EngineExecution["engineKind"]): EngineKind {
  return EngineKind[kind];
}

function dbSeverity(severity: ReviewFinding["severity"]): FindingSeverity {
  return FindingSeverity[severity];
}

function isTerminalWithResult(status: JobStatus): boolean {
  return status === JobStatus.COMPLETED || status === JobStatus.PARTIAL;
}

export async function getPersistedReviewResult(
  foundationJobId: string,
): Promise<PersistReviewResult | undefined> {
  const current = await prisma.foundationJob.findUnique({
    where: { id: foundationJobId },
    select: { status: true, _count: { select: { findings: true } } },
  });
  if (!current || !isTerminalWithResult(current.status)) return undefined;
  return {
    replayed: true,
    status: current.status as ReviewOutcome,
    findingCount: current._count.findings,
  };
}

/** Persists only validated structured records; its input intentionally has no raw diff or provider body. */
export async function persistReviewResult(input: PersistReviewInput): Promise<PersistReviewResult> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.foundationJob.findUniqueOrThrow({
      where: { id: input.foundationJobId },
      select: { status: true },
    });
    if (isTerminalWithResult(current.status)) {
      const findingCount = await tx.finding.count({ where: { foundationJobId: input.foundationJobId } });
      return { replayed: true, status: current.status, findingCount } as PersistReviewResult;
    }

    for (const finding of input.findings) {
      const persisted = await tx.finding.upsert({
        where: {
          foundationJobId_fingerprint: {
            foundationJobId: input.foundationJobId,
            fingerprint: finding.fingerprint,
          },
        },
        update: {
          severity: dbSeverity(finding.severity),
          summary: finding.summary,
          reasoning: finding.reasoning,
          snippet: finding.snippet,
          startLine: finding.startLine,
          endLine: finding.endLine,
        },
        create: {
          foundationJobId: input.foundationJobId,
          filePath: finding.filePath,
          startLine: finding.startLine,
          endLine: finding.endLine,
          severity: dbSeverity(finding.severity),
          category: finding.category,
          fingerprint: finding.fingerprint,
          summary: finding.summary,
          reasoning: finding.reasoning,
          snippet: finding.snippet,
        },
        select: { id: true },
      });
      await tx.findingProvenance.createMany({
        data: finding.provenance.map((provenance) => ({
          findingId: persisted.id,
          engineKind: EngineKind[provenance.engineKind],
          engineIdentifier: provenance.engineIdentifier,
          staticRuleId: provenance.staticRuleId,
        })),
        skipDuplicates: true,
      });
    }

    for (const execution of input.executions) {
      await tx.engineRun.upsert({
        where: {
          foundationJobId_engineIdentifier: {
            foundationJobId: input.foundationJobId,
            engineIdentifier: execution.engineIdentifier,
          },
        },
        update: {
          engineKind: dbKind(execution.engineKind),
          outcome: dbOutcome(execution.code),
          durationMs: execution.durationMs,
          findingCount: execution.findings.length,
        },
        create: {
          foundationJobId: input.foundationJobId,
          engineKind: dbKind(execution.engineKind),
          engineIdentifier: execution.engineIdentifier,
          outcome: dbOutcome(execution.code),
          durationMs: execution.durationMs,
          findingCount: execution.findings.length,
        },
      });
    }

    await tx.foundationJob.update({
      where: { id: input.foundationJobId },
      data: {
        status: JobStatus[input.outcome],
        changedLineCount: input.changedLineCount,
        outsideLatencyCohort: input.outsideLatencyCohort,
        reviewDurationMs: input.reviewDurationMs,
        completedAt: new Date(),
        failureReason: input.outcome === "FAILED" ? "review_failed" : null,
      },
    });

    return { replayed: false, status: input.outcome, findingCount: input.findings.length };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
