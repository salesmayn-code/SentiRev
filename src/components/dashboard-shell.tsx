"use client";

import Link from "next/link";

export type DashboardState =
  | "empty"
  | "loading"
  | "error"
  | "success"
  | "unauthorized";

export type RepositorySummary = {
  id: string;
  fullName: string;
  connectionStatus: "CONNECTED" | "DISCONNECTED";
  reviewedPullRequests: number;
};

type DashboardShellProps = {
  repositories?: RepositorySummary[];
  initialState?: DashboardState;
  initialError?: string;
  currentRepository?: string;
};

export function DashboardShell({
  repositories = [],
  initialState = "empty",
  initialError,
  currentRepository,
}: DashboardShellProps) {
  const state = initialState;
  const repositoryOptions = repositories.map(({ id, fullName }) => ({ id, fullName }));

  return (
    <>
      <div className="dashboard-desktop-content">
        <div className="dashboard-heading-row">
          <div className="dashboard-heading">
            <p className="eyebrow">Authenticated repository view</p>
            <h1 id="dashboard-heading">Repositories</h1>
            <p className="lede">
              Connected repositories appear here as soon as GitHub confirms the
              installation. Review findings will appear only after a new pull
              request event is processed.
            </p>
          </div>
        </div>

        {state === "unauthorized" ? (
          <section
            className="state-region state-region-unauthorized"
            role="alert"
            aria-labelledby="access-required-heading"
          >
            <p className="state-label">Access check</p>
            <h2 id="access-required-heading">Repository admin access required</h2>
            <p>
              Only a GitHub repository administrator can view connected
              repositories. Sign in with the administrator account that
              installed the App.
            </p>
            <div className="form-actions">
              <Link className="primary-button" href="/api/auth/github">
                Sign in with GitHub
              </Link>
              <Link className="secondary-button" href="/">
                Return to SentiRev
              </Link>
            </div>
          </section>
        ) : null}

        {state === "loading" ? (
          <section
            className="state-region state-region-loading"
            aria-busy="true"
            aria-live="polite"
            aria-labelledby="repository-loading-heading"
          >
            <p className="state-label">Repository connection</p>
            <h2 id="repository-loading-heading">Loading connected repositories…</h2>
            <p>Checking the latest GitHub installation state.</p>
          </section>
        ) : null}

        {state === "error" ? (
          <section
            className="state-region state-region-error"
            role="alert"
            aria-labelledby="repository-error-heading"
          >
            <p className="state-label">Repository connection</p>
            <h2 id="repository-error-heading">Repository list unavailable</h2>
            <p>
              {initialError ||
                "GitHub could not return the connected repositories. No connection status was changed."}
            </p>
            <div className="form-actions">
              <Link className="primary-button" href="/dashboard">
                Retry connection
              </Link>
              <Link className="secondary-button" href="/install">
                Connect a repository
              </Link>
            </div>
          </section>
        ) : null}

        {state === "success" ? (
          <section
            className="state-region state-region-success"
            role="status"
            aria-live="polite"
            aria-labelledby="repository-success-heading"
          >
            <p className="state-label">Connection status</p>
            <h2 id="repository-success-heading">Repository connection is ready</h2>
            <p>
              GitHub confirmed the connection. The repository list below is
              ready for new pull-request events.
            </p>
          </section>
        ) : null}

        {state !== "unauthorized" && state !== "loading" && state !== "error" ? (
          <section className="dashboard-content-stack" aria-labelledby="repository-list-heading">
            <div className="dashboard-heading-row">
              <div className="dashboard-heading">
                <p className="eyebrow">Connected repositories</p>
                <h2 id="repository-list-heading">
                  {repositories.length === 0
                    ? "No connected repositories"
                    : `${repositories.length} connected ${repositories.length === 1 ? "repository" : "repositories"}`}
                </h2>
              </div>
              <Link className="secondary-button" href="/install">
                Connect a repository
              </Link>
            </div>

            {repositories.length > 0 ? (
              <ul className="repository-list" aria-label="Connected repositories">
                {repositories.map((repository) => (
                  <li className="repository-row" key={repository.id}>
                    <div className="repository-row-heading">
                      <span className="repository-name">{repository.fullName}</span>
                      <span className="repository-status">
                        {repository.connectionStatus === "CONNECTED"
                          ? "Connected"
                          : "Disconnected"}
                      </span>
                    </div>
                    <p className="supporting-copy">
                      {repository.reviewedPullRequests === 0
                        ? "No reviewed pull requests yet. New pull requests will appear after the next signed webhook."
                        : `${repository.reviewedPullRequests} reviewed pull ${repository.reviewedPullRequests === 1 ? "request" : "requests"}.`}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state" role="status" aria-live="polite">
                <div className="empty-state-copy">
                  <p className="state-label">Repository list</p>
                  <h3>No repositories connected yet</h3>
                  <p>
                    Install the GitHub App and choose at least one repository.
                    The repository will appear here immediately, even before a
                    pull request has been reviewed.
                  </p>
                </div>
                <div className="form-actions">
                  <Link className="primary-button" href="/install">
                    Connect a repository
                  </Link>
                </div>
              </div>
            )}

            {repositories.length > 0 ? (
              <p className="footer-note">
                Repository metadata is shown for the authenticated GitHub
                administrator. Findings and review history are not part of this
                initial connection state.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>

      <section
        className="dashboard-mobile-gate"
        aria-labelledby="desktop-required-heading"
      >
        <div className="gate-panel">
          <p className="eyebrow">Dashboard access</p>
          <h1 id="desktop-required-heading">Use a desktop browser for the dashboard</h1>
          <p>
            The repository view starts at 1024px wide so file and connection
            details remain readable. Return to the public site on this device,
            or log out before switching accounts.
          </p>
          <div className="gate-actions">
            <Link className="secondary-button" href="/">
              Return to public site
            </Link>
            <Link className="primary-button" href="/api/auth/logout">
              Log out
            </Link>
          </div>
        </div>
      </section>

      {repositoryOptions.length > 0 ? (
        <span className="sr-only" aria-hidden="true">
          {currentRepository ?? repositoryOptions[0]?.id}
        </span>
      ) : null}
    </>
  );
}
