import type {
  ConnectionStatus,
  ConsentMode,
  EngineKind,
  FindingSeverity,
  JobStatus,
  ReviewCommentDelivery,
  ReviewFeedbackKind,
  ReviewFeedbackStatus,
  ReviewRetryStatus,
} from "@prisma/client";

export const DASHBOARD_MAX_DISMISSAL_NOTE_LENGTH = 1_000;

export type DashboardRepositorySummary = {
  id: string;
  name: string;
  fullName: string;
  ownerLogin: string;
  connectionStatus: ConnectionStatus;
  consentMode: ConsentMode | null;
  reviewedPullRequests: number;
};

export type DashboardFindingProvenance = {
  engineKind: EngineKind;
  engineIdentifier: string;
  staticRuleId: string | null;
};

export type DashboardDismissal = {
  id: string;
  note: string;
  dismissedAt: string;
  dismissedByLogin: string;
  undoneAt: string | null;
};

export type DashboardFinding = {
  id: string;
  foundationJobId: string;
  pullRequestNumber: number;
  jobStatus: JobStatus;
  severity: FindingSeverity;
  filePath: string;
  startLine: number;
  endLine: number;
  category: string;
  summary: string;
  reasoning: string;
  snippet: string;
  provenance: DashboardFindingProvenance[];
  createdAt: string;
  dismissed: boolean;
  dismissal: DashboardDismissal | null;
};

export type DashboardJob = {
  id: string;
  pullRequestNumber: number;
  headSha: string;
  status: JobStatus;
  attempts: number;
  changedLineCount: number | null;
  reviewDurationMs: number | null;
  outsideLatencyCohort: boolean;
  failure: "review_failed" | null;
  createdAt: string;
  completedAt: string | null;
  feedback: DashboardFeedbackDelivery[];
};

export type DashboardFeedbackDelivery = {
  id: string;
  kind: ReviewFeedbackKind;
  status: ReviewFeedbackStatus;
  githubCommentId: string | null;
  postedAt: string | null;
  errorCode: string | null;
  findingId: string | null;
};

export type DashboardSeverityCount = {
  severity: FindingSeverity;
  count: number;
};

export type DashboardTrendPoint = {
  date: string;
  total: number;
  bySeverity: DashboardSeverityCount[];
};

export type DashboardRepositoryData = {
  repository: DashboardRepositorySummary & {
    consentRecordedAt: string | null;
    createdAt: string;
  };
  jobs: DashboardJob[];
  findings: DashboardFinding[];
  dismissedFindings: DashboardFinding[];
  severityBreakdown: DashboardSeverityCount[];
  trend: DashboardTrendPoint[];
};

export type DashboardErrorCode =
  | "authentication_required"
  | "repository_access_denied"
  | "authorization_unavailable"
  | "invalid_input"
  | "finding_not_found"
  | "job_not_found"
  | "finding_already_dismissed"
  | "finding_not_dismissed"
  | "repository_name_mismatch"
  | "repository_not_disconnected"
  | "retry_not_available"
  | "operation_failed";

export type DashboardActionFailure = {
  ok: false;
  error: DashboardErrorCode;
  retryable: boolean;
};

export type DashboardActionSuccess<T> = {
  ok: true;
  data: T;
};

export type DashboardActionResult<T> =
  | DashboardActionSuccess<T>
  | DashboardActionFailure;

export type DismissFindingResult = {
  findingId: string;
  dismissalId: string;
  note: string;
  dismissedAt: string;
};

export type UndoDismissalResult = {
  findingId: string;
  dismissalId: string;
  undoneAt: string;
};

export type ConsentUpdateResult = {
  repositoryId: string;
  mode: ConsentMode;
  recordedAt: string;
};

export type DisconnectRepositoryResult = {
  repositoryId: string;
  connectionStatus: ConnectionStatus;
};

export type DeleteHistoryResult = {
  repositoryId: string;
  deleted: {
    pullRequests: number;
    jobs: number;
    findings: number;
    feedbackDeliveries: number;
    retryRequests: number;
  };
};

export type RetryReviewResult = {
  retryRequestId: string;
  foundationJobId: string;
  status: ReviewRetryStatus;
};

// Keep this import type available for downstream consumers that need to map a
// Prisma delivery without importing Prisma at runtime from a client boundary.
export type DashboardDeliveryRecord = Pick<
  ReviewCommentDelivery,
  "id" | "kind" | "status" | "githubCommentId" | "postedAt" | "errorCode" | "findingId"
>;
