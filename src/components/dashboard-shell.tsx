"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  deleteRepositoryHistory,
  dismissFinding,
  disconnectRepository,
  requestReviewRetry,
  setRepositoryConsent,
  undoFindingDismissal,
} from "@/lib/dashboard/actions";
import type {
  DashboardActionFailure,
  DashboardFinding,
  DashboardJob,
  DashboardRepositoryData,
  DashboardRepositorySummary,
  DashboardSeverityCount,
  DashboardTrendPoint,
} from "@/lib/dashboard/types";

export type DashboardState =
  | "empty"
  | "loading"
  | "error"
  | "success"
  | "unauthorized";

export type RepositorySummary = DashboardRepositorySummary;

type DashboardShellProps = {
  repositories?: DashboardRepositorySummary[];
  initialData?: DashboardRepositoryData;
  initialState?: DashboardState;
  initialError?: string;
  currentRepository?: string;
};

type ActionResponse =
  | { ok: true; text: string }
  | { ok: false; text: string };

type ActionMessage = {
  tone: "success" | "error" | "info";
  text: string;
};

const severityClass: Record<string, string> = {
  Critical: "severity-critical",
  High: "severity-high",
  Medium: "severity-medium",
  Low: "severity-low",
};

const statusClass: Record<string, string> = {
  QUEUED: "status-queued",
  RUNNING: "status-reviewing",
  COMPLETED: "status-complete",
  PARTIAL: "status-delayed",
  FAILED: "status-failed",
};

function errorMessage(error: DashboardActionFailure["error"]): string {
  switch (error) {
    case "authentication_required":
      return "Your GitHub session is required. Sign in and try again.";
    case "repository_access_denied":
      return "GitHub no longer confirms administrator access for this repository.";
    case "authorization_unavailable":
      return "GitHub could not confirm administrator access. Try again.";
    case "invalid_input":
      return "Check the entered value and try again.";
    case "finding_not_found":
      return "This finding is no longer available. Refresh the dashboard.";
    case "job_not_found":
      return "This review job is no longer available. Refresh the dashboard.";
    case "finding_already_dismissed":
      return "This finding was already dismissed. Refresh the dashboard.";
    case "finding_not_dismissed":
      return "This finding is not currently dismissed. Refresh the dashboard.";
    case "repository_name_mismatch":
      return "Enter the exact repository name to confirm permanent deletion.";
    case "repository_not_disconnected":
      return "Disconnect the repository before deleting its history.";
    case "retry_not_available":
      return "This review is no longer eligible for a retry.";
    case "operation_failed":
    default:
      return "The action could not be completed. Your entered data was kept.";
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Not recorded";
  return value.slice(0, 10);
}

function formatTime(value: string | null): string {
  if (!value) return "Not completed";
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

function engineLabel(finding: DashboardFinding): string {
  const first = finding.provenance[0];
  if (!first) return "Engine not recorded";
  return first.engineKind === "AI"
    ? `AI · ${first.engineIdentifier}`
    : `Static · ${first.engineIdentifier}`;
}

function statusLabel(job: DashboardJob): string {
  switch (job.status) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Reviewing";
    case "PARTIAL":
      return "Delayed";
    case "FAILED":
      return "Failed";
    case "COMPLETED":
    default:
      return "Complete";
  }
}

function hasNoFindingsFeedback(job: DashboardJob): boolean {
  return job.feedback.some(
    (delivery) => delivery.kind === "NO_FINDINGS" && delivery.status === "POSTED",
  );
}

function failedDeliveryCount(job: DashboardJob): number {
  return job.feedback.filter((delivery) => delivery.status === "FAILED").length;
}

function canRetryJob(job: DashboardJob): boolean {
  return job.status === "FAILED" || job.status === "PARTIAL" || failedDeliveryCount(job) > 0;
}

function statusExplanation(job: DashboardJob): string {
  if (hasNoFindingsFeedback(job)) return "Review complete — no findings";
  if (failedDeliveryCount(job) > 0) {
    return "GitHub feedback was not delivered. Retry review to send the recorded outcome.";
  }
  if (job.status === "PARTIAL") {
    return "Static findings were retained; the AI review is delayed.";
  }
  if (job.status === "FAILED") {
    return "The review did not complete. No result was silently discarded.";
  }
  if (job.status === "RUNNING") return "The review engines are processing this pull request.";
  if (job.status === "QUEUED") return "This pull request is waiting for the review worker.";
  return "Findings and review feedback have been recorded.";
}

function actionResult(
  result: { ok: true } | { ok: false; error: DashboardActionFailure["error"] },
  successText: string,
): ActionResponse {
  return result.ok
    ? { ok: true, text: successText }
    : { ok: false, text: errorMessage(result.error) };
}

function SeverityMark({ severity }: { severity: string }) {
  return (
    <span className={`severity-mark ${severityClass[severity] ?? "severity-low"}`}>
      <span className="severity-tick" aria-hidden="true" />
      <span>{severity}</span>
    </span>
  );
}

function FindingItem({
  finding,
  dismissed,
  onDismiss,
  onUndo,
}: {
  finding: DashboardFinding;
  dismissed?: boolean;
  onDismiss: (finding: DashboardFinding, note: string) => Promise<ActionResponse>;
  onUndo: (finding: DashboardFinding) => Promise<ActionResponse>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  async function submitDismissal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!note.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await onDismiss(finding, note);
    setBusy(false);
    setMessage({ tone: result.ok ? "success" : "error", text: result.text });
    if (result.ok) setNote("");
  }

  async function submitUndo() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await onUndo(finding);
    setBusy(false);
    setMessage({ tone: result.ok ? "success" : "error", text: result.text });
  }

  return (
    <details className={`finding-item${dismissed ? " finding-item-dismissed" : ""}`}>
      <summary
        className="finding-row"
        aria-label={`${finding.severity} finding in ${finding.filePath} at line ${finding.startLine}`}
      >
        <span className="finding-cell finding-severity" role="cell">
          <SeverityMark severity={dismissed ? "Dismissed" : finding.severity} />
        </span>
        <span className="finding-cell finding-location" role="cell">
          <span className="finding-file mono">{finding.filePath}</span>
          <span className="finding-line mono">
            line {finding.startLine === finding.endLine
              ? finding.startLine
              : `${finding.startLine}–${finding.endLine}`}
          </span>
        </span>
        <span className="finding-cell finding-summary" role="cell">
          <span className="finding-summary-text">{finding.summary}</span>
          <span className="finding-category mono">{finding.category}</span>
        </span>
        <span className="finding-cell finding-engine" role="cell">
          {engineLabel(finding)}
        </span>
        <span className="finding-cell finding-expand" aria-hidden="true">
          View
        </span>
      </summary>

      <div className="finding-detail" role="region" aria-label={`Details for ${finding.filePath}`}>
        <div className="finding-detail-main">
          <div className="finding-detail-heading">
            <p className="eyebrow">Finding detail</p>
            <p className="finding-citation mono">
              {finding.filePath}:{finding.startLine}
            </p>
          </div>
          <p className="finding-reasoning">{finding.reasoning}</p>
          <div
            className="finding-code-scroll"
            role="region"
            aria-label={`Cited code from ${finding.filePath}, lines ${finding.startLine} to ${finding.endLine}`}
            tabIndex={0}
          >
            <p className="code-region-label">Cited code</p>
            <pre><code>{finding.snippet}</code></pre>
          </div>
          <dl className="finding-provenance">
            <div>
              <dt>Engine</dt>
              <dd>{finding.provenance.length > 0
                ? finding.provenance.map((item) => `${item.engineKind === "AI" ? "AI" : "Static"} · ${item.engineIdentifier}`).join(", ")
                : "Not recorded"}</dd>
            </div>
            <div>
              <dt>Pull request</dt>
              <dd>#{finding.pullRequestNumber}</dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{formatTime(finding.createdAt)}</dd>
            </div>
          </dl>
        </div>
        <aside className="finding-detail-annotation" aria-label="Finding action">
          {dismissed ? (
            <div className="dismissed-note">
              <p className="eyebrow">False-positive note</p>
              <p>{finding.dismissal?.note ?? "No note recorded."}</p>
              <p className="supporting-copy">
                Dismissed by {finding.dismissal?.dismissedByLogin ?? "the repository admin"} on {formatDate(finding.dismissal?.dismissedAt ?? null)}.
              </p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void submitUndo()}
                disabled={busy}
                aria-disabled={busy}
              >
                {busy ? "Undoing…" : "Undo dismissal"}
              </button>
            </div>
          ) : (
            <form className="dismiss-form" onSubmit={(event) => void submitDismissal(event)}>
              <label htmlFor={`dismiss-note-${finding.id}`}>Dismiss as a false positive</label>
              <span className="supporting-copy">Add a short note. This keeps the finding in history.</span>
              <textarea
                id={`dismiss-note-${finding.id}`}
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
                maxLength={1_000}
                rows={4}
                disabled={busy}
                aria-describedby={`dismiss-note-help-${finding.id}`}
              />
              <span id={`dismiss-note-help-${finding.id}`} className="field-hint">
                {note.length}/1,000 characters
              </span>
              <button
                type="submit"
                className="secondary-button"
                disabled={busy || !note.trim()}
                aria-disabled={busy || !note.trim()}
              >
                {busy ? "Saving…" : "Dismiss finding"}
              </button>
            </form>
          )}
          {message ? (
            <p className={`inline-action-message inline-action-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
              {message.text}
            </p>
          ) : null}
        </aside>
      </div>
    </details>
  );
}

function FindingGridItem({
  finding,
  dismissed,
  onDismiss,
  onUndo,
  onAnnounce,
}: {
  finding: DashboardFinding;
  dismissed?: boolean;
  onDismiss: (finding: DashboardFinding, note: string) => Promise<ActionResponse>;
  onUndo: (finding: DashboardFinding) => Promise<ActionResponse>;
  onAnnounce: (message: ActionMessage) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const detailId = `finding-detail-${finding.id}`;

  async function submitDismissal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!note.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await onDismiss(finding, note);
    setBusy(false);
    if (result.ok) {
      setNote("");
      onAnnounce({ tone: "success", text: result.text });
    } else {
      setError(result.text);
    }
  }

  async function submitUndo() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await onUndo(finding);
    setBusy(false);
    if (result.ok) {
      onAnnounce({ tone: "success", text: result.text });
    } else {
      setError(result.text);
    }
  }

  return (
    <div className={`finding-item${dismissed ? " finding-item-dismissed" : ""}${expanded ? " finding-item-expanded" : ""}`}>
      <div className="finding-row" role="row">
        <div className="finding-cell finding-severity" role="gridcell">
          <SeverityMark severity={dismissed ? "Dismissed" : finding.severity} />
        </div>
        <div className="finding-cell finding-location" role="gridcell">
          <span className="finding-file mono">{finding.filePath}</span>
          <span className="finding-line mono">
            line {finding.startLine === finding.endLine ? finding.startLine : `${finding.startLine}-${finding.endLine}`}
          </span>
        </div>
        <div className="finding-cell finding-summary" role="gridcell">
          <span className="finding-summary-text">{finding.summary}</span>
          <span className="finding-category mono">{finding.category}</span>
        </div>
        <div className="finding-cell finding-engine" role="gridcell">{engineLabel(finding)}</div>
        <div className="finding-cell finding-expand" role="gridcell">
          <button
            type="button"
            className="finding-expand-button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide" : "View"}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="finding-detail-row" role="row">
          <div className="finding-detail-cell" role="gridcell" aria-colspan={5}>
            <div id={detailId} className="finding-detail" role="region" aria-label={`Details for ${finding.filePath}`}>
              <div className="finding-detail-main">
                <div className="finding-detail-heading">
                  <p className="eyebrow">Finding detail</p>
                  <p className="finding-citation mono">{finding.filePath}:{finding.startLine}</p>
                </div>
                <p className="finding-reasoning">{finding.reasoning}</p>
                <div
                  className="finding-code-scroll"
                  role="region"
                  aria-label={`Cited code from ${finding.filePath}, lines ${finding.startLine} to ${finding.endLine}`}
                  tabIndex={0}
                >
                  <p className="code-region-label">Cited code</p>
                  <pre><code>{finding.snippet}</code></pre>
                </div>
                <dl className="finding-provenance">
                  <div>
                    <dt>Engine</dt>
                    <dd>{finding.provenance.length > 0
                      ? finding.provenance.map((item) => `${item.engineKind === "AI" ? "AI" : "Static"}: ${item.engineIdentifier}`).join(", ")
                      : "Not recorded"}</dd>
                  </div>
                  <div><dt>Pull request</dt><dd>#{finding.pullRequestNumber}</dd></div>
                  <div><dt>Recorded</dt><dd>{formatTime(finding.createdAt)}</dd></div>
                </dl>
              </div>
              <aside className="finding-detail-annotation" aria-label="Finding action">
                {dismissed ? (
                  <div className="dismissed-note">
                    <p className="eyebrow">False-positive note</p>
                    <p>{finding.dismissal?.note ?? "No note recorded."}</p>
                    <p className="supporting-copy">
                      Dismissed by {finding.dismissal?.dismissedByLogin ?? "the repository admin"} on {formatDate(finding.dismissal?.dismissedAt ?? null)}.
                    </p>
                    <button type="button" className="secondary-button" onClick={() => void submitUndo()} disabled={busy} aria-disabled={busy}>
                      {busy ? "Undoing..." : "Undo dismissal"}
                    </button>
                  </div>
                ) : (
                  <form className="dismiss-form" onSubmit={(event) => void submitDismissal(event)}>
                    <label htmlFor={`dismiss-note-${finding.id}`}>Dismiss as a false positive</label>
                    <span className="supporting-copy">Add a short note. This keeps the finding in history.</span>
                    <textarea
                      id={`dismiss-note-${finding.id}`}
                      value={note}
                      onChange={(event) => setNote(event.currentTarget.value)}
                      maxLength={1_000}
                      rows={4}
                      disabled={busy}
                      aria-describedby={`dismiss-note-help-${finding.id}`}
                    />
                    <span id={`dismiss-note-help-${finding.id}`} className="field-hint">{note.length}/1,000 characters</span>
                    <button type="submit" className="secondary-button" disabled={busy || !note.trim()} aria-disabled={busy || !note.trim()}>
                      {busy ? "Saving..." : "Dismiss finding"}
                    </button>
                  </form>
                )}
                {error ? <p className="inline-action-message inline-action-message-error" role="alert">{error}</p> : null}
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FindingsSection({
  data,
  onDismiss,
  onUndo,
  onAnnounce,
}: {
  data: DashboardRepositoryData;
  onDismiss: (finding: DashboardFinding, note: string) => Promise<ActionResponse>;
  onUndo: (finding: DashboardFinding) => Promise<ActionResponse>;
  onAnnounce: (message: ActionMessage) => void;
}) {
  const noReviewedPullRequests = data.jobs.length === 0 && data.repository.reviewedPullRequests === 0;
  return (
    <section className="dashboard-section findings-section" aria-labelledby="findings-heading">
      <div className="section-heading-row">
        <div className="section-heading">
          <p className="eyebrow">Current review findings</p>
          <h2 id="findings-heading">Open findings</h2>
        </div>
        <span className="section-count" aria-label={`${data.findings.length} open findings`}>
          {data.findings.length} open
        </span>
      </div>

      {data.findings.length > 0 ? (
        <div className="findings-table" role="grid" aria-label="Open review findings">
          <div className="findings-header" role="row">
            <span role="columnheader">Severity</span>
            <span role="columnheader">Citation</span>
            <span role="columnheader">Summary</span>
            <span role="columnheader">Engine</span>
            <span className="sr-only" role="columnheader">Details</span>
          </div>
          <div className="findings-body">
            {data.findings.map((finding) => (
              <FindingGridItem
                key={finding.id}
                finding={finding}
                onDismiss={onDismiss}
                onUndo={onUndo}
                onAnnounce={onAnnounce}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="empty-state dashboard-empty-state" role="status" aria-live="polite">
          <p className="state-label">Finding list</p>
          <h3>{data.dismissedFindings.length > 0 ? "No open findings" : "No findings yet"}</h3>
          <p>
            {noReviewedPullRequests
              ? "No pull requests have been reviewed yet. New pull requests will appear after the next signed webhook."
              : data.dismissedFindings.length > 0
                ? "All findings for this repository are currently dismissed. Open the dismissed group below to review their notes."
                : "The latest completed review did not record a finding."}
          </p>
        </div>
      )}

      {data.dismissedFindings.length > 0 ? (
        <details className="dismissed-group">
          <summary>
            <span>Dismissed findings</span>
            <span className="section-count">{data.dismissedFindings.length}</span>
          </summary>
          <div className="findings-table findings-table-dismissed" role="grid" aria-label="Dismissed review findings">
            <div className="findings-header" role="row">
              <span role="columnheader">Status</span>
              <span role="columnheader">Citation</span>
              <span role="columnheader">Summary</span>
              <span role="columnheader">Engine</span>
              <span className="sr-only" role="columnheader">Details</span>
            </div>
            <div className="findings-body">
              {data.dismissedFindings.map((finding) => (
                <FindingGridItem
                  key={finding.id}
                  finding={finding}
                  dismissed
                  onDismiss={onDismiss}
                  onUndo={onUndo}
                  onAnnounce={onAnnounce}
                />
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ReviewActivity({
  jobs,
  onRetry,
}: {
  jobs: DashboardJob[];
  onRetry: (job: DashboardJob) => Promise<ActionResponse>;
}) {
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  async function retry(job: DashboardJob) {
    if (busyJobId) return;
    setBusyJobId(job.id);
    setMessage(null);
    const result = await onRetry(job);
    setBusyJobId(null);
    setMessage({ tone: result.ok ? "success" : "error", text: result.text });
  }

  return (
    <section className="dashboard-section review-activity" aria-labelledby="review-activity-heading">
      <div className="section-heading-row">
        <div className="section-heading">
          <p className="eyebrow">Signed pull-request events</p>
          <h2 id="review-activity-heading">Review activity</h2>
        </div>
        {jobs.length > 0 ? <span className="section-count">{jobs.length} jobs</span> : null}
      </div>
      {jobs.length === 0 ? (
        <div className="state-region state-region-loading" role="status">
          <p className="state-label">No review activity</p>
          <p>No new or updated pull request has reached the review worker yet.</p>
        </div>
      ) : (
        <ol className="review-job-list">
          {jobs.map((job) => (
            <li className="review-job-row" key={job.id}>
              <div className="review-job-main">
                <div className="review-job-title-row">
                  <h3>Pull request <span className="mono">#{job.pullRequestNumber}</span></h3>
                  <span className={`job-status ${statusClass[job.status] ?? "status-queued"}`}>
                    <span className="status-tick" aria-hidden="true" />
                    {statusLabel(job)}
                  </span>
                </div>
                <p className="supporting-copy">{statusExplanation(job)}</p>
                {failedDeliveryCount(job) > 0 ? (
                  <p className="delivery-warning" role="status">
                    GitHub feedback pending retry: {failedDeliveryCount(job)} {failedDeliveryCount(job) === 1 ? "delivery" : "deliveries"} not delivered.
                  </p>
                ) : null}
                <dl className="job-meta">
                  <div><dt>Head</dt><dd className="mono">{job.headSha.slice(0, 12)}</dd></div>
                  <div><dt>Changed</dt><dd>{job.changedLineCount === null ? "Not recorded" : `${job.changedLineCount} lines`}</dd></div>
                  <div><dt>Recorded</dt><dd>{formatTime(job.createdAt)}</dd></div>
                  <div><dt>Duration</dt><dd>{job.reviewDurationMs === null ? "Not completed" : `${job.reviewDurationMs} ms`}</dd></div>
                </dl>
              </div>
              {canRetryJob(job) ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void retry(job)}
                  disabled={busyJobId !== null}
                  aria-disabled={busyJobId !== null}
                >
                  {busyJobId === job.id ? "Retrying…" : "Retry review"}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {message ? (
        <p className={`inline-action-message inline-action-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function SeverityBreakdown({ counts }: { counts: DashboardSeverityCount[] }) {
  const max = Math.max(1, ...counts.map((entry) => entry.count));
  return (
    <section className="dashboard-section metric-section" aria-labelledby="severity-heading">
      <div className="section-heading">
        <p className="eyebrow">Open finding count</p>
        <h2 id="severity-heading">Severity breakdown</h2>
      </div>
      <ul className="severity-list">
        {counts.map((entry) => (
          <li key={entry.severity} className="severity-bar-row">
            <div className="severity-bar-label">
              <SeverityMark severity={entry.severity} />
              <span className="severity-count">{entry.count}</span>
            </div>
            <div className="severity-bar-track" aria-hidden="true">
              <span
                className={`severity-bar-fill ${severityClass[entry.severity] ?? "severity-low"}`}
                style={{ width: `${(entry.count / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="supporting-copy">Dismissed findings are excluded from active counts.</p>
    </section>
  );
}

function TrendChart({ points }: { points: DashboardTrendPoint[] }) {
  const max = Math.max(1, ...points.map((point) => point.total));
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
    const y = 92 - (point.total / max) * 76;
    return `${x},${y}`;
  }).join(" ");

  return (
    <section className="dashboard-section metric-section trend-section" aria-labelledby="trend-heading">
      <div className="section-heading">
        <p className="eyebrow">Recorded findings by review date</p>
        <h2 id="trend-heading">Trend over time</h2>
      </div>
      {points.length === 0 ? (
        <div className="state-region" role="status">
          <p>No trend data is available until a pull request is reviewed.</p>
        </div>
      ) : (
        <>
          <p className="trend-summary">
            {points.reduce((total, point) => total + point.total, 0)} findings across {points.length} review {points.length === 1 ? "date" : "dates"}.
          </p>
          <div className="trend-axis-labels" aria-hidden="true">
            <span>{max} findings</span>
            <span>Review date</span>
          </div>
          <div className="trend-chart" role="img" aria-label="Line chart of total findings by review date">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line className="trend-grid-line" x1="0" y1="16" x2="100" y2="16" />
              <line className="trend-grid-line" x1="0" y1="54" x2="100" y2="54" />
              <line className="trend-axis-line" x1="0" y1="92" x2="100" y2="92" />
              <polyline className="trend-line" points={coordinates} />
              {points.map((point, index) => {
                const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
                const y = 92 - (point.total / max) * 76;
                return <circle className="trend-point" key={`${point.date}-${index}`} cx={x} cy={y} r="2" />;
              })}
            </svg>
          </div>
          <table className="trend-data-table">
            <caption className="sr-only">Finding trend data</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Total findings</th></tr></thead>
            <tbody>
              {points.map((point) => <tr key={point.date}><th scope="row">{point.date}</th><td>{point.total}</td></tr>)}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function ConfirmDialog({
  kind,
  repository,
  busy,
  error,
  confirmation,
  onConfirmationChange,
  onCancel,
  onConfirm,
}: {
  kind: "disconnect" | "delete";
  repository: DashboardRepositoryData["repository"];
  busy: boolean;
  error: string | null;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const hasInitialFocus = useRef(false);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);

  useEffect(() => {
    onCancelRef.current = onCancel;
    busyRef.current = busy;
  }, [busy, onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled])",
    ));
    if (!hasInitialFocus.current) {
      focusable()[0]?.focus();
      hasInitialFocus.current = true;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, []);

  const deleting = kind === "delete";
  return (
    <div className="dashboard-dialog-layer" role="presentation">
      <div
        ref={dialogRef}
        className="dashboard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${kind}-dialog-title`}
        aria-describedby={`${kind}-dialog-description`}
        tabIndex={-1}
      >
        <p className="eyebrow">Repository settings</p>
        <h2 id={`${kind}-dialog-title`}>{deleting ? "Delete review history" : "Disconnect repository"}</h2>
        <p id={`${kind}-dialog-description`}>
          {deleting
            ? `This permanently deletes findings, snippets, jobs, and feedback history for ${repository.fullName}. The repository record stays disconnected. This cannot be undone.`
            : `Disconnect ${repository.fullName} from future reviews. Stored history remains available until you explicitly delete it.`}
        </p>
        {deleting ? (
          <div className="dialog-field">
            <label htmlFor="delete-repository-confirmation">Type the repository name to confirm</label>
            <span className="field-hint">Enter {repository.fullName} exactly.</span>
            <input
              id="delete-repository-confirmation"
              value={confirmation}
              onChange={(event) => onConfirmationChange(event.currentTarget.value)}
              autoComplete="off"
              disabled={busy}
              aria-describedby="delete-repository-hint"
            />
            <span id="delete-repository-hint" className="sr-only">Exact repository name required.</span>
          </div>
        ) : null}
        {error ? <p className="inline-action-message inline-action-message-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={deleting ? "danger-button" : "primary-button"}
            onClick={onConfirm}
            disabled={busy || (deleting && confirmation !== repository.fullName)}
            aria-disabled={busy || (deleting && confirmation !== repository.fullName)}
          >
            {busy ? (deleting ? "Deleting…" : "Disconnecting…") : (deleting ? "Delete history" : "Disconnect repository")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RepositorySettings({
  data,
  onConsent,
  onDisconnect,
  onDelete,
}: {
  data: DashboardRepositoryData;
  onConsent: (mode: "AI_ALLOWED" | "STATIC_ONLY") => Promise<ActionResponse>;
  onDisconnect: () => Promise<ActionResponse>;
  onDelete: (confirmation: string) => Promise<ActionResponse>;
}) {
  const [consentBusy, setConsentBusy] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const [dialog, setDialog] = useState<"disconnect" | "delete" | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const disconnectTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);

  async function updateConsent(mode: "AI_ALLOWED" | "STATIC_ONLY") {
    if (consentBusy) return;
    setConsentBusy(true);
    setMessage(null);
    const result = await onConsent(mode);
    setConsentBusy(false);
    setMessage({ tone: result.ok ? "success" : "error", text: result.text });
  }

  function openDialog(kind: "disconnect" | "delete") {
    setDialogError(null);
    setConfirmation("");
    setDialog(kind);
  }

  function closeDialog() {
    if (dialogBusy) return;
    const trigger = dialog === "delete" ? deleteTrigger : disconnectTrigger;
    setDialog(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  async function confirmDialog() {
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    setDialogError(null);
    const result = dialog === "disconnect"
      ? await onDisconnect()
      : await onDelete(confirmation);
    setDialogBusy(false);
    if (!result.ok) {
      setDialogError(result.text);
      return;
    }
    setDialog(null);
    setMessage({ tone: "success", text: result.text });
    requestAnimationFrame(() => {
      const trigger = dialog === "delete" ? deleteTrigger : disconnectTrigger;
      trigger.current?.focus();
    });
  }

  return (
    <section id="repository-settings" className="dashboard-section repository-settings" aria-labelledby="settings-heading">
      <div className="section-heading">
        <p className="eyebrow">Admin-only controls</p>
        <h2 id="settings-heading">Repository settings</h2>
      </div>
      <div className="settings-grid">
        <div className="consent-setting">
          <div className="setting-heading-row">
            <h3>AI processing consent</h3>
            <span className={`setting-mode ${data.repository.consentMode === "AI_ALLOWED" ? "setting-mode-on" : "setting-mode-off"}`}>
              {data.repository.consentMode === "AI_ALLOWED" ? "On" : "Off"}
            </span>
          </div>
          <label className="consent-switch">
            <input
              type="checkbox"
              role="switch"
              checked={data.repository.consentMode === "AI_ALLOWED"}
              onChange={(event) => void updateConsent(event.currentTarget.checked ? "AI_ALLOWED" : "STATIC_ONLY")}
              disabled={consentBusy}
              aria-describedby="consent-description"
            />
            <span>Allow Cohere North Mini Code Free review after Semgrep</span>
          </label>
          <p id="consent-description" className="supporting-copy">
            On sends bounded changed-diff hunks to the owner-managed OpenRouter Cohere provider. Off runs Semgrep only. Full source files are not sent.
          </p>
          <p className="field-hint">Last recorded: {formatTime(data.repository.consentRecordedAt)}</p>
        </div>
        <div className="settings-danger-zone">
          <h3>Connection and history</h3>
          <p className="supporting-copy">Disconnecting stops future review events but keeps this repository and its history visible.</p>
          <div className="settings-actions">
            <button ref={disconnectTrigger} type="button" className="secondary-button" onClick={() => openDialog("disconnect")}>
              Disconnect repository
            </button>
            <button ref={deleteTrigger} type="button" className="danger-button" onClick={() => openDialog("delete")}>
              Delete review history
            </button>
          </div>
        </div>
      </div>
      {message ? (
        <p className={`inline-action-message inline-action-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      {dialog ? (
        <ConfirmDialog
          kind={dialog}
          repository={data.repository}
          busy={dialogBusy}
          error={dialogError}
          confirmation={confirmation}
          onConfirmationChange={setConfirmation}
          onCancel={closeDialog}
          onConfirm={() => void confirmDialog()}
        />
      ) : null}
    </section>
  );
}

function RepositoryDirectory({
  repositories,
  currentRepository,
}: {
  repositories: DashboardRepositorySummary[];
  currentRepository?: string;
}) {
  if (repositories.length === 0) {
    return (
      <section className="dashboard-section repository-directory" aria-labelledby="repository-list-heading">
        <div className="section-heading">
          <p className="eyebrow">Connected repositories</p>
          <h2 id="repository-list-heading">No connected repositories</h2>
        </div>
        <div className="empty-state dashboard-empty-state" role="status" aria-live="polite">
          <p className="state-label">Repository list</p>
          <h3>Connect a repository to begin</h3>
          <p>
            Install the GitHub App and choose at least one repository. It will appear here immediately, even before a pull request has been reviewed.
          </p>
          <div className="form-actions"><Link className="primary-button" href="/install">Connect a repository</Link></div>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-section repository-directory" aria-labelledby="repository-list-heading">
      <div className="section-heading-row">
        <div className="section-heading">
          <p className="eyebrow">Connected repositories</p>
          <h2 id="repository-list-heading">Repositories</h2>
        </div>
        <Link className="secondary-button" href="/install">Connect a repository</Link>
      </div>
      <nav aria-label="Connected repositories">
        <ul className="repository-directory-list">
          {repositories.map((repository) => {
            const current = repository.id === currentRepository;
            return (
              <li key={repository.id}>
                <Link
                  className={`repository-directory-link${current ? " repository-directory-link-current" : ""}`}
                  href={`/dashboard?repository=${encodeURIComponent(repository.id)}`}
                  aria-current={current ? "page" : undefined}
                >
                  <span className="repository-directory-name mono">{repository.fullName}</span>
                  <span className="repository-directory-meta">
                    <span className={`connection-status connection-status-${repository.connectionStatus.toLowerCase()}`}>
                      {repository.connectionStatus === "CONNECTED" ? "Connected" : "Disconnected"}
                    </span>
                    <span>{repository.reviewedPullRequests} reviewed {repository.reviewedPullRequests === 1 ? "PR" : "PRs"}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </section>
  );
}

export function DashboardShell({
  repositories: initialRepositories = [],
  initialData,
  initialState = "empty",
  initialError,
  currentRepository,
}: DashboardShellProps) {
  const [repositories, setRepositories] = useState(initialRepositories);
  const [data, setData] = useState<DashboardRepositoryData | undefined>(initialData);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);

  useEffect(() => {
    setRepositories(initialRepositories);
    setData(initialData);
  }, [initialData, initialRepositories]);

  const currentSummary = useMemo(
    () => repositories.find((repository) => repository.id === currentRepository),
    [currentRepository, repositories],
  );

  async function handleDismiss(finding: DashboardFinding, note: string): Promise<ActionResponse> {
    const result = await dismissFinding({ findingId: finding.id, note });
    if (!result.ok) return actionResult(result, "");
    setData((current) => {
      if (!current) return current;
      const dismissed: DashboardFinding = {
        ...finding,
        dismissed: true,
        dismissal: {
          id: result.data.dismissalId,
          note: result.data.note,
          dismissedAt: result.data.dismissedAt,
          dismissedByLogin: "You",
          undoneAt: null,
        },
      };
      return {
        ...current,
        findings: current.findings.filter((item) => item.id !== finding.id),
        dismissedFindings: [...current.dismissedFindings, dismissed],
        severityBreakdown: current.severityBreakdown.map((entry) => entry.severity === finding.severity
          ? { ...entry, count: Math.max(0, entry.count - 1) }
          : entry),
      };
    });
    return { ok: true, text: "Finding dismissed. Its history is preserved." };
  }

  async function handleUndo(finding: DashboardFinding): Promise<ActionResponse> {
    const result = await undoFindingDismissal({
      findingId: finding.id,
      dismissalId: finding.dismissal?.id,
    });
    if (!result.ok) return actionResult(result, "");
    setData((current) => {
      if (!current) return current;
      const restored = {
        ...finding,
        dismissed: false,
        dismissal: null,
      };
      return {
        ...current,
        findings: [...current.findings, restored],
        dismissedFindings: current.dismissedFindings.filter((item) => item.id !== finding.id),
        severityBreakdown: current.severityBreakdown.map((entry) => entry.severity === finding.severity
          ? { ...entry, count: entry.count + 1 }
          : entry),
      };
    });
    return { ok: true, text: "Dismissal undone. Finding returned to the open list." };
  }

  async function handleRetry(job: DashboardJob): Promise<ActionResponse> {
    if (!data) return { ok: false, text: "Review data is not available. Refresh and try again." };
    const result = await requestReviewRetry({ repositoryId: data.repository.id, foundationJobId: job.id });
    if (!result.ok) return actionResult(result, "");
    setData((current) => current ? {
      ...current,
      jobs: current.jobs.map((candidate) => candidate.id === job.id
        ? {
          ...candidate,
          status: "QUEUED" as const,
          attempts: candidate.attempts + 1,
          feedback: candidate.feedback.map((delivery) => delivery.status === "FAILED"
            ? { ...delivery, status: "PENDING" as const, errorCode: null }
            : delivery),
        }
        : candidate),
    } : current);
    return { ok: true, text: "Review retry requested. The job is queued again." };
  }

  async function handleConsent(mode: "AI_ALLOWED" | "STATIC_ONLY"): Promise<ActionResponse> {
    if (!data) return { ok: false, text: "Repository data is not available. Refresh and try again." };
    const result = await setRepositoryConsent({ repositoryId: data.repository.id, mode });
    if (!result.ok) return actionResult(result, "");
    setData((current) => current ? {
      ...current,
      repository: {
        ...current.repository,
        consentMode: result.data.mode,
        consentRecordedAt: result.data.recordedAt,
      },
    } : current);
    setRepositories((current) => current.map((repository) => repository.id === data.repository.id
      ? { ...repository, consentMode: result.data.mode }
      : repository));
    return { ok: true, text: mode === "AI_ALLOWED" ? "AI processing consent saved." : "Static-only review saved." };
  }

  async function handleDisconnect(): Promise<ActionResponse> {
    if (!data) return { ok: false, text: "Repository data is not available. Refresh and try again." };
    const result = await disconnectRepository({ repositoryId: data.repository.id });
    if (!result.ok) return actionResult(result, "");
    setData((current) => current ? {
      ...current,
      repository: { ...current.repository, connectionStatus: result.data.connectionStatus },
    } : current);
    setRepositories((current) => current.map((repository) => repository.id === data.repository.id
      ? { ...repository, connectionStatus: result.data.connectionStatus }
      : repository));
    return { ok: true, text: "Repository disconnected. Its history remains available." };
  }

  async function handleDelete(confirmation: string): Promise<ActionResponse> {
    if (!data) return { ok: false, text: "Repository data is not available. Refresh and try again." };
    const result = await deleteRepositoryHistory({
      repositoryId: data.repository.id,
      expectedRepositoryName: confirmation,
    });
    if (!result.ok) return actionResult(result, "");
    setData((current) => current ? {
      ...current,
      jobs: [],
      findings: [],
      dismissedFindings: [],
      severityBreakdown: current.severityBreakdown.map((entry) => ({ ...entry, count: 0 })),
      trend: [],
    } : current);
    setActionMessage({ tone: "success", text: "Review history deleted. The disconnected repository record remains." });
    return { ok: true, text: "Review history deleted. The disconnected repository record remains." };
  }

  const state = initialState;
  const hasRepository = repositories.length > 0;

  return (
    <>
      <div className="dashboard-desktop-content">
        <div className="dashboard-heading-row dashboard-page-heading">
          <div className="dashboard-heading">
            <p className="eyebrow">Authenticated repository view</p>
            <h1 id="dashboard-heading">Repository review</h1>
            <p className="lede">
              A consistent, explainable review for new and updated pull requests. Findings stay advisory and cited.
            </p>
          </div>
          {hasRepository ? <span className="admin-badge">GitHub repository admin</span> : null}
        </div>

        {state === "unauthorized" ? (
          <section className="state-region state-region-unauthorized" role="alert" aria-labelledby="access-required-heading">
            <p className="state-label">Access check</p>
            <h2 id="access-required-heading">Repository admin access required</h2>
            <p>Only a GitHub repository administrator can view connected repositories. Sign in with the administrator account that installed the App.</p>
            <div className="form-actions">
              <Link className="primary-button" href="/api/auth/github">Sign in with GitHub</Link>
              <Link className="secondary-button" href="/">Return to SentiRev</Link>
            </div>
          </section>
        ) : null}

        {state === "loading" ? (
          <section className="state-region state-region-loading" aria-busy="true" aria-live="polite" aria-labelledby="repository-loading-heading">
            <p className="state-label">Repository connection</p>
            <h2 id="repository-loading-heading">Loading connected repositories…</h2>
            <p>Checking the latest GitHub installation state.</p>
          </section>
        ) : null}

        {state === "error" ? (
          <section className="state-region state-region-error" role="alert" aria-labelledby="repository-error-heading">
            <p className="state-label">Repository connection</p>
            <h2 id="repository-error-heading">Repository review unavailable</h2>
            <p>{initialError || "The dashboard could not load the latest repository state. No connection status was changed."}</p>
            <div className="form-actions">
              <Link className="primary-button" href="/dashboard">Retry connection</Link>
              <Link className="secondary-button" href="/install">Connect a repository</Link>
            </div>
          </section>
        ) : null}

        {state !== "unauthorized" && state !== "loading" ? (
          <div className="dashboard-content-stack">
            <RepositoryDirectory repositories={repositories} currentRepository={currentRepository} />
            {data ? (
              <>
                <section className="repository-context" aria-labelledby="current-repository-heading">
                  <div>
                    <p className="eyebrow">Selected repository</p>
                    <h2 id="current-repository-heading" className="repository-context-name mono">{data.repository.fullName}</h2>
                  </div>
                  <div className="repository-context-meta">
                    <span className={`connection-status connection-status-${data.repository.connectionStatus.toLowerCase()}`}>
                      {data.repository.connectionStatus === "CONNECTED" ? "Connected" : "Disconnected"}
                    </span>
                    <span className="supporting-copy">{data.repository.reviewedPullRequests} reviewed {data.repository.reviewedPullRequests === 1 ? "PR" : "PRs"}</span>
                  </div>
                </section>
                {actionMessage ? (
                  <p className={`inline-action-message inline-action-message-${actionMessage.tone}`} role={actionMessage.tone === "error" ? "alert" : "status"}>
                    {actionMessage.text}
                  </p>
                ) : null}
                <ReviewActivity jobs={data.jobs} onRetry={handleRetry} />
                <FindingsSection
                  data={data}
                  onDismiss={handleDismiss}
                  onUndo={handleUndo}
                  onAnnounce={setActionMessage}
                />
                <div className="dashboard-metrics-grid">
                  <SeverityBreakdown counts={data.severityBreakdown} />
                  <TrendChart points={data.trend} />
                </div>
                <RepositorySettings data={data} onConsent={handleConsent} onDisconnect={handleDisconnect} onDelete={handleDelete} />
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="dashboard-mobile-gate" aria-labelledby="desktop-required-heading">
        <div className="gate-panel">
          <p className="eyebrow">Dashboard access</p>
          <h1 id="desktop-required-heading">Use a desktop browser for the dashboard</h1>
          <p>
            The repository view starts at 1024px wide so file and connection details remain readable{currentSummary ? ` for ${currentSummary.fullName}.` : "."} Return to the public site on this device, or log out before switching accounts.
          </p>
          <div className="gate-actions">
            <Link className="secondary-button" href="/">Return to public site</Link>
            <Link className="primary-button" href="/api/auth/logout">Log out</Link>
          </div>
        </div>
      </section>
    </>
  );
}
