import {
  FindingSeverity,
  type Prisma,
} from "@prisma/client";

import {
  RepositoryAuthorizationError,
  requireRepositoryAdmin,
} from "@/lib/auth/authorization";
import type { Session } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import {
  isRepositoryAdmin,
  type GitHubRepository,
} from "@/lib/github/client";

import type {
  DashboardFinding,
  DashboardFindingProvenance,
  DashboardFeedbackDelivery,
  DashboardJob,
  DashboardRepositoryData,
  DashboardRepositorySummary,
  DashboardSeverityCount,
  DashboardTrendPoint,
} from "./types";

const SEVERITY_ORDER: readonly FindingSeverity[] = [
  FindingSeverity.Critical,
  FindingSeverity.High,
  FindingSeverity.Medium,
  FindingSeverity.Low,
];

export class DashboardAccessError extends Error {
  readonly code: "authentication_required" | "repository_access_denied" | "authorization_unavailable";
  readonly retryable: boolean;

  constructor(
    code: "authentication_required" | "repository_access_denied" | "authorization_unavailable",
    retryable = false,
  ) {
    super(code);
    this.name = "DashboardAccessError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type DashboardDataDependencies = {
  authorize?: (
    session: Session,
    fullName: string,
  ) => Promise<GitHubRepository>;
};

type StoredRepository = Prisma.RepositoryGetPayload<{
  select: {
    id: true;
    githubRepositoryId: true;
    ownerLogin: true;
    name: true;
    fullName: true;
    connectionStatus: true;
    createdAt: true;
    installation: { select: { ownerUserId: true } };
    consent: { select: { mode: true; recordedAt: true } };
    _count: { select: { pullRequests: true } };
  };
}>;

const dashboardRepositorySelect = {
  id: true,
  githubRepositoryId: true,
  ownerLogin: true,
  name: true,
  fullName: true,
  connectionStatus: true,
  createdAt: true,
  installation: { select: { ownerUserId: true } },
  consent: { select: { mode: true, recordedAt: true } },
  _count: { select: { pullRequests: true } },
} satisfies Prisma.RepositorySelect;

function asDateString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function severityRank(value: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(value);
}

function sortFindings(left: DashboardFinding, right: DashboardFinding): number {
  return (
    severityRank(left.severity) - severityRank(right.severity)
    || left.filePath.localeCompare(right.filePath)
    || left.startLine - right.startLine
    || left.createdAt.localeCompare(right.createdAt)
  );
}

function countBySeverity(findings: readonly DashboardFinding[]): DashboardSeverityCount[] {
  const counts = new Map<FindingsSeverityValue, number>(
    SEVERITY_ORDER.map((severity) => [severity, 0]),
  );
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    count: counts.get(severity) ?? 0,
  }));
}

type FindingsSeverityValue = FindingSeverity;

function buildTrend(findings: readonly DashboardFinding[]): DashboardTrendPoint[] {
  const grouped = new Map<string, DashboardFinding[]>();
  for (const finding of findings) {
    const date = finding.createdAt.slice(0, 10);
    const day = grouped.get(date) ?? [];
    day.push(finding);
    grouped.set(date, day);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({
      date,
      total: day.length,
      bySeverity: countBySeverity(day),
    }));
}

async function findStoredRepository(
  session: Session,
  repositoryId: string,
): Promise<StoredRepository | null> {
  return prisma.repository.findFirst({
    where: {
      id: repositoryId,
      installation: { ownerUserId: session.userId },
    },
    select: dashboardRepositorySelect,
  });
}

/**
 * Loads the repository after the local ownership boundary and the current
 * GitHub admin check both pass. The GitHub response is used only for the
 * authorization decision; dashboard data comes from the durable local rows.
 */
export async function requireAuthorizedRepository(
  session: Session | null,
  repositoryId: string,
  dependencies: DashboardDataDependencies = {},
): Promise<StoredRepository> {
  if (!session) {
    throw new DashboardAccessError("authentication_required");
  }

  const repository = await findStoredRepository(session, repositoryId);
  if (!repository || repository.installation.ownerUserId !== session.userId) {
    throw new DashboardAccessError("repository_access_denied");
  }

  try {
    const githubRepository = await (dependencies.authorize ?? requireRepositoryAdmin)(
      session,
      repository.fullName,
    );
    if (
      !isRepositoryAdmin(githubRepository)
      ||
      String(githubRepository.id) !== repository.githubRepositoryId
      || githubRepository.full_name !== repository.fullName
    ) {
      throw new DashboardAccessError("authorization_unavailable", true);
    }
  } catch (error) {
    if (error instanceof DashboardAccessError) throw error;
    if (error instanceof RepositoryAuthorizationError) {
      throw new DashboardAccessError("repository_access_denied");
    }
    throw new DashboardAccessError("authorization_unavailable", true);
  }

  return repository;
}

function toRepositorySummary(repository: StoredRepository): DashboardRepositorySummary {
  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.fullName,
    ownerLogin: repository.ownerLogin,
    connectionStatus: repository.connectionStatus,
    consentMode: repository.consent?.mode ?? null,
    reviewedPullRequests: repository._count.pullRequests,
  };
}

/**
 * Returns only repositories still confirmed as administrator-visible by
 * GitHub. A repository that fails the current admin check is omitted without
 * disclosing its stored metadata.
 */
export async function getDashboardRepositories(
  session: Session | null,
  dependencies: DashboardDataDependencies = {},
): Promise<DashboardRepositorySummary[]> {
  if (!session) {
    throw new DashboardAccessError("authentication_required");
  }

  const repositories = await prisma.repository.findMany({
    where: { installation: { ownerUserId: session.userId } },
    orderBy: { fullName: "asc" },
    select: dashboardRepositorySelect,
  });

  const authorized: DashboardRepositorySummary[] = [];
  for (const repository of repositories) {
    try {
      await requireAuthorizedRepository(session, repository.id, dependencies);
      authorized.push(toRepositorySummary(repository));
    } catch (error) {
      if (error instanceof DashboardAccessError && error.code === "repository_access_denied") {
        continue;
      }
      throw error;
    }
  }
  return authorized;
}

type DashboardJobRow = Prisma.FoundationJobGetPayload<{
  select: {
    id: true;
    status: true;
    attempts: true;
    changedLineCount: true;
    reviewDurationMs: true;
    outsideLatencyCohort: true;
    failureReason: true;
    createdAt: true;
    completedAt: true;
    pullRequest: { select: { githubNumber: true; headSha: true } };
    feedbackDeliveries: {
      select: {
        id: true;
        kind: true;
        status: true;
        githubCommentId: true;
        postedAt: true;
        errorCode: true;
        findingId: true;
      };
    };
    findings: {
      select: {
        id: true;
        foundationJobId: true;
        filePath: true;
        startLine: true;
        endLine: true;
        severity: true;
        category: true;
        summary: true;
        reasoning: true;
        snippet: true;
        createdAt: true;
        provenance: {
          select: {
            engineKind: true;
            engineIdentifier: true;
            staticRuleId: true;
          };
        };
        dismissals: {
          where: { undoneAt: null };
          orderBy: [{ dismissedAt: "desc" }];
          take: 1;
          select: {
            id: true;
            note: true;
            dismissedAt: true;
            undoneAt: true;
            dismissedBy: { select: { login: true } };
          };
        };
      };
    };
  };
}>;

const dashboardJobSelect = {
  id: true,
  status: true,
  attempts: true,
  changedLineCount: true,
  reviewDurationMs: true,
  outsideLatencyCohort: true,
  failureReason: true,
  createdAt: true,
  completedAt: true,
  pullRequest: { select: { githubNumber: true, headSha: true } },
  feedbackDeliveries: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      githubCommentId: true,
      postedAt: true,
      errorCode: true,
      findingId: true,
    },
  },
  findings: {
    orderBy: [{ severity: "asc" }, { filePath: "asc" }, { startLine: "asc" }],
    select: {
      id: true,
      foundationJobId: true,
      filePath: true,
      startLine: true,
      endLine: true,
      severity: true,
      category: true,
      summary: true,
      reasoning: true,
      snippet: true,
      createdAt: true,
      provenance: {
        orderBy: { createdAt: "asc" },
        select: {
          engineKind: true,
          engineIdentifier: true,
          staticRuleId: true,
        },
      },
      dismissals: {
        where: { undoneAt: null },
        orderBy: { dismissedAt: "desc" },
        take: 1,
        select: {
          id: true,
          note: true,
          dismissedAt: true,
          undoneAt: true,
          dismissedBy: { select: { login: true } },
        },
      },
    },
  },
} satisfies Prisma.FoundationJobSelect;

function toFeedbackDelivery(
  delivery: DashboardJobRow["feedbackDeliveries"][number],
): DashboardFeedbackDelivery {
  return {
    id: delivery.id,
    kind: delivery.kind,
    status: delivery.status,
    githubCommentId: delivery.githubCommentId,
    postedAt: asDateString(delivery.postedAt),
    errorCode: delivery.errorCode,
    findingId: delivery.findingId,
  };
}

function toFinding(
  row: DashboardJobRow["findings"][number],
  pullRequestNumber: number,
  jobStatus: DashboardJob["status"],
): DashboardFinding {
  const activeDismissal = row.dismissals[0];
  const provenance: DashboardFindingProvenance[] = row.provenance.map((item) => ({
    engineKind: item.engineKind,
    engineIdentifier: item.engineIdentifier,
    staticRuleId: item.staticRuleId,
  }));
  return {
    id: row.id,
    foundationJobId: row.foundationJobId,
    pullRequestNumber,
    jobStatus,
    severity: row.severity,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    category: row.category,
    summary: row.summary,
    reasoning: row.reasoning,
    snippet: row.snippet,
    provenance,
    createdAt: row.createdAt.toISOString(),
    dismissed: Boolean(activeDismissal),
    dismissal: activeDismissal
      ? {
          id: activeDismissal.id,
          note: activeDismissal.note,
          dismissedAt: activeDismissal.dismissedAt.toISOString(),
          dismissedByLogin: activeDismissal.dismissedBy.login,
          undoneAt: asDateString(activeDismissal.undoneAt),
        }
      : null,
  };
}

function toJob(row: DashboardJobRow): DashboardJob {
  return {
    id: row.id,
    pullRequestNumber: row.pullRequest.githubNumber,
    headSha: row.pullRequest.headSha,
    status: row.status,
    attempts: row.attempts,
    changedLineCount: row.changedLineCount,
    reviewDurationMs: row.reviewDurationMs,
    outsideLatencyCohort: row.outsideLatencyCohort,
    // Raw worker/provider error text is intentionally not part of the read
    // model. The stable code preserves enough context for a retry affordance.
    failure: row.failureReason ? "review_failed" : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: asDateString(row.completedAt),
    feedback: row.feedbackDeliveries.map(toFeedbackDelivery),
  };
}

export async function getDashboardData(
  session: Session | null,
  repositoryId: string,
  dependencies: DashboardDataDependencies = {},
): Promise<DashboardRepositoryData> {
  const repository = await requireAuthorizedRepository(session, repositoryId, dependencies);
  const rows = await prisma.foundationJob.findMany({
    where: { pullRequest: { repositoryId: repository.id } },
    orderBy: { createdAt: "desc" },
    select: dashboardJobSelect,
  });

  const jobs = rows.map(toJob);
  const findings = rows.flatMap((row) =>
    row.findings.map((finding) => {
      const job = jobs.find((candidate) => candidate.id === row.id)!;
      return toFinding(finding, row.pullRequest.githubNumber, job.status);
    }),
  );
  const uniqueFindings = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
  const openFindings = uniqueFindings.filter((finding) => !finding.dismissed).sort(sortFindings);
  const dismissedFindings = uniqueFindings.filter((finding) => finding.dismissed).sort(sortFindings);
  const summary = toRepositorySummary(repository);

  return {
    repository: {
      ...summary,
      consentRecordedAt: asDateString(repository.consent?.recordedAt),
      createdAt: repository.createdAt.toISOString(),
    },
    jobs,
    findings: openFindings,
    dismissedFindings,
    severityBreakdown: countBySeverity(openFindings),
    trend: buildTrend(uniqueFindings),
  };
}
