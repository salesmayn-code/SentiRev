"use client";

import { useCallback, useEffect, useState } from "react";

export type ConsentMode = "ai" | "static";
export type InstallState = "idle" | "connecting" | "error" | "success";

type AvailableRepository = {
  id: string;
  name: string;
  fullName: string;
  ownerLogin: string;
};

type InstallFlowProps = {
  initialMode?: ConsentMode;
  initialState?: InstallState;
  initialError?: string;
};

const errorCopy: Record<string, string> = {
  cancelled: "GitHub installation was cancelled. Your choice was kept; you can try again.",
  denied: "GitHub did not grant the required repository permission. Check the repository administrator account and retry.",
  unavailable: "GitHub could not complete the connection. No repository was marked as connected.",
  unknown: "The connection could not be completed. No repository was marked as connected.",
};

function getErrorCopy(error?: string) {
  return (error && errorCopy[error]) || errorCopy.unknown;
}

export function InstallFlow({
  initialMode = "ai",
  initialState = "idle",
  initialError,
}: InstallFlowProps) {
  const [mode, setMode] = useState<ConsentMode>(initialMode);
  const [state, setState] = useState<InstallState>(initialState);

  const isConnecting = state === "connecting";
  const hasError = state === "error";

  return (
    <section className="install-panel panel" aria-labelledby="install-heading">
      <header>
        <p className="eyebrow">Phase 001 / connection boundary</p>
        <h1 id="install-heading">Connect a GitHub repository</h1>
        <p className="lede">
          Choose the processing boundary first. SentiRev starts with repository
          and webhook metadata so the connection can be verified before any
          pull-request review work begins.
        </p>
      </header>

      <div className="section-rule" aria-hidden="true" />

      {hasError ? (
        <div className="status status-error" role="alert">
          <p className="status-title">Connection not completed</p>
          <p>{getErrorCopy(initialError)}</p>
        </div>
      ) : null}

      {state === "success" ? (
        <div className="status status-success" role="status" aria-live="polite">
          <p className="status-title">Repository connection recorded</p>
          <p>
            GitHub returned a repository connection. Open the dashboard to see
            its initial zero-review state.
          </p>
          <a className="secondary-button" href="/dashboard">
            Open dashboard
          </a>
        </div>
      ) : null}

      {isConnecting ? (
        <div className="status" role="status" aria-live="polite" aria-busy="true">
          <p className="status-title">Opening GitHub installation…</p>
          <p>Keep this tab open while GitHub confirms the repository access.</p>
        </div>
      ) : null}

      <div className="data-list" aria-label="Data-use boundary">
        <div>
          <p className="eyebrow">What SentiRev sees now</p>
          <p>
            The connection records your GitHub identity, installation, selected
            repository metadata, and signed webhook metadata for new pull
            requests.
          </p>
        </div>
        <div>
          <p className="eyebrow">What this phase does not send</p>
          <p>
            Phase 001 does not send a pull-request diff to an AI provider and
            does not create a finding or review comment.
          </p>
        </div>
      </div>

      <form
        action="/api/github/install"
        method="get"
        onSubmit={() => setState("connecting")}
      >
        <fieldset className="consent-fieldset" disabled={isConnecting}>
          <legend className="consent-legend">
            Choose the repository processing mode
          </legend>
          <p id="consent-help" className="supporting-copy">
            You can connect with static analysis only, or allow the named AI
            providers for later pull-request reviews. This choice is recorded
            with the connection.
          </p>
          <div className="consent-options">
            <label className="consent-option">
              <input
                type="radio"
                name="consentMode"
                value="ai"
                checked={mode === "ai"}
                onChange={() => {
                  setMode("ai");
                  setState("idle");
                }}
                aria-describedby="consent-help"
              />
              <span className="consent-option-copy">
                <span className="consent-option-title">Semgrep plus AI review</span>
                <span className="supporting-copy">
                  When enabled, later review diffs may be sent to Laguna S 2.1,
                  with Nemotron 3 Ultra as the named fallback. No provider key
                  is entered here.
                </span>
              </span>
            </label>
            <label className="consent-option">
              <input
                type="radio"
                name="consentMode"
                value="static"
                checked={mode === "static"}
                onChange={() => {
                  setMode("static");
                  setState("idle");
                }}
                aria-describedby="consent-help"
              />
              <span className="consent-option-copy">
                <span className="consent-option-title">Static-only review</span>
                <span className="supporting-copy">
                  Use Semgrep only. No pull-request content is sent to an AI
                  provider under this mode.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="form-actions">
          <button
            className="primary-button"
            type="submit"
            aria-disabled={isConnecting}
            disabled={isConnecting}
          >
            {isConnecting ? (
              <>
                <span className="inline-progress" aria-hidden="true" />
                Connecting…
              </>
            ) : hasError ? (
              "Retry connection"
            ) : (
              "Continue to GitHub"
            )}
          </button>
          <a className="secondary-button" href="/">
            Return to SentiRev
          </a>
        </div>
      </form>

      <p className="footer-note">
        GitHub repository administrators are required to install the App. This
        page never asks repository users for an AI-provider API key.
      </p>
    </section>
  );
}

type ConnectState = "loading" | "ready" | "submitting" | "error" | "success";

type ConnectFlowProps = {
  installationId: string;
  initialMode?: ConsentMode;
  initialError?: string;
};

function getConnectionError(error: string | undefined) {
  if (error === "repository_admin_required") {
    return "Only repositories you administer can be connected. Choose an administrator repository and retry.";
  }
  if (error === "repositories_unavailable") {
    return "GitHub could not return the repositories for this installation. No repository was marked as connected.";
  }
  if (error === "installation_failed") {
    return "The repository connection failed. No repository was marked as connected.";
  }
  if (error === "invalid_install_state") {
    return "The installation confirmation expired or did not match this session. Start the installation again.";
  }
  if (error === "installation_cancelled") {
    return "The GitHub installation was cancelled. No repository was marked as connected.";
  }
  if (error === "missing_installation") {
    return "GitHub did not return a usable installation. Start the installation again.";
  }
  if (error === "installation_not_allowed") {
    return "This installation belongs to a different GitHub session. Sign in with the administrator account and retry.";
  }
  return "The repository list could not be loaded. No repository was marked as connected.";
}

export function ConnectFlow({
  installationId,
  initialMode = "ai",
  initialError,
}: ConnectFlowProps) {
  const [mode, setMode] = useState<ConsentMode>(initialMode);
  const [repositories, setRepositories] = useState<AvailableRepository[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [state, setState] = useState<ConnectState>(initialError ? "error" : "loading");
  const [error, setError] = useState<string | undefined>(initialError);
  const [connectedCount, setConnectedCount] = useState(0);

  const loadRepositories = useCallback(async () => {
    setState("loading");
    setError(undefined);

    try {
      const response = await fetch(
        `/api/github/install/repositories?installation_id=${encodeURIComponent(installationId)}`,
        { headers: { Accept: "application/json" } },
      );
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" || !("repositories" in payload)) {
        const code =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : undefined;
        throw new Error(getConnectionError(code));
      }

      const nextRepositories = Array.isArray(payload.repositories)
        ? payload.repositories.filter(
            (repository): repository is AvailableRepository =>
              Boolean(
                repository &&
                  typeof repository === "object" &&
                  "id" in repository &&
                  typeof repository.id === "string" &&
                  "name" in repository &&
                  typeof repository.name === "string" &&
                  "fullName" in repository &&
                  typeof repository.fullName === "string" &&
                  "ownerLogin" in repository &&
                  typeof repository.ownerLogin === "string",
              ),
          )
        : [];
      setRepositories(nextRepositories);
      setSelectedIds([]);
      setState("ready");
    } catch (loadError) {
      setState("error");
      setError(loadError instanceof Error ? loadError.message : getConnectionError(undefined));
    }
  }, [installationId]);

  useEffect(() => {
    if (!initialError) {
      void loadRepositories();
    }
  }, [initialError, loadRepositories]);

  async function completeConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedIds.length === 0) {
      setState("error");
      setError("Choose at least one repository before continuing.");
      return;
    }

    setState("submitting");
    setError(undefined);
    try {
      const response = await fetch("/api/github/install/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          installationId,
          repositoryIds: selectedIds,
          consentMode: mode === "ai" ? "AI_ALLOWED" : "STATIC_ONLY",
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : undefined;
        throw new Error(getConnectionError(code));
      }
      setConnectedCount(selectedIds.length);
      setState("success");
    } catch (completionError) {
      setState("error");
      setError(
        completionError instanceof Error
          ? completionError.message
          : getConnectionError(undefined),
      );
    }
  }

  const isBusy = state === "loading" || state === "submitting";

  return (
    <section className="install-panel panel" aria-labelledby="connect-heading">
      <header>
        <p className="eyebrow">Phase 001 / repository selection</p>
        <h1 id="connect-heading">Select repositories to connect</h1>
        <p className="lede">
          Select only repositories you administer. SentiRev records the
          installation and your processing choice, then shows the connection in
          the dashboard even before a pull request is reviewed.
        </p>
      </header>

      <div className="section-rule" aria-hidden="true" />

      {state === "loading" ? (
        <div className="status" role="status" aria-live="polite" aria-busy="true">
          <p className="status-title">Loading repositories…</p>
          <p>Checking the repositories available to this GitHub installation.</p>
        </div>
      ) : null}

      {state === "error" ? (
        <div className="status status-error" role="alert">
          <p className="status-title">Connection needs attention</p>
          <p>{error}</p>
          <div className="form-actions">
            <button className="secondary-button" type="button" onClick={() => void loadRepositories()}>
              Retry repository list
            </button>
          </div>
        </div>
      ) : null}

      {state === "success" ? (
        <div className="status status-success" role="status" aria-live="polite">
          <p className="status-title">
            {connectedCount} {connectedCount === 1 ? "repository" : "repositories"} connected
          </p>
          <p>
            The selected repositories are ready for new pull-request events.
            Review analysis has not run in this foundation phase.
          </p>
          <a className="secondary-button" href="/dashboard">
            Open dashboard
          </a>
        </div>
      ) : null}

      {state === "ready" && repositories.length === 0 ? (
        <div className="status" role="status" aria-live="polite">
          <p className="status-title">No administrable repositories returned</p>
          <p>
            GitHub did not return a repository that this account can administer.
            No repository was marked as connected.
          </p>
        </div>
      ) : null}

      {(state === "ready" || state === "submitting") && repositories.length > 0 ? (
        <form onSubmit={completeConnection}>
          <fieldset className="consent-fieldset" disabled={isBusy}>
            <legend className="consent-legend">Repositories</legend>
            <p id="repository-help" className="supporting-copy">
              Choose one or more repositories. The list is limited to repositories
              where GitHub confirms administrator access.
            </p>
            <ul className="repository-options" aria-describedby="repository-help">
              {repositories.map((repository) => {
                const checked = selectedIds.includes(repository.id);
                return (
                  <li key={repository.id}>
                    <label className="repository-choice">
                      <input
                        type="checkbox"
                        name="repositoryIds"
                        value={repository.id}
                        checked={checked}
                        onChange={() => {
                          setSelectedIds((current) =>
                            checked
                              ? current.filter((id) => id !== repository.id)
                              : [...current, repository.id],
                          );
                          setState("ready");
                          setError(undefined);
                        }}
                      />
                      <span className="repository-choice-copy">
                        <span className="repository-name">{repository.fullName}</span>
                        <span className="supporting-copy">
                          Administrator: {repository.ownerLogin}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <div className="section-rule" aria-hidden="true" />

            <div className="consent-options">
              <p className="consent-legend">Processing mode</p>
              <label className="consent-option">
                <input
                  type="radio"
                  name="connectConsentMode"
                  value="ai"
                  checked={mode === "ai"}
                  onChange={() => setMode("ai")}
                  aria-describedby="connect-consent-help"
                />
                <span className="consent-option-copy">
                  <span className="consent-option-title">Semgrep plus AI review</span>
                  <span className="supporting-copy">
                    Later diffs may be sent to Laguna S 2.1, with Nemotron 3 Ultra
                    as its named fallback.
                  </span>
                </span>
              </label>
              <label className="consent-option">
                <input
                  type="radio"
                  name="connectConsentMode"
                  value="static"
                  checked={mode === "static"}
                  onChange={() => setMode("static")}
                  aria-describedby="connect-consent-help"
                />
                <span className="consent-option-copy">
                  <span className="consent-option-title">Static-only review</span>
                  <span className="supporting-copy">
                    Semgrep only; no pull-request content is sent to an AI provider.
                  </span>
                </span>
              </label>
              <p id="connect-consent-help" className="supporting-copy">
                This choice is stored with the repository connection. Provider
                keys are managed by the SentiRev app owner.
              </p>
            </div>
          </fieldset>

          <div className="form-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={isBusy || selectedIds.length === 0}
              aria-disabled={isBusy || selectedIds.length === 0}
            >
              {state === "submitting" ? (
                <>
                  <span className="inline-progress" aria-hidden="true" />
                  Saving connection…
                </>
              ) : (
                "Connect selected repositories"
              )}
            </button>
            <a className="secondary-button" href="/">
              Cancel
            </a>
          </div>
        </form>
      ) : null}

      <p className="footer-note">
        Installation ID <span className="mono">{installationId}</span>. Only
        GitHub repository administrators can complete this connection.
      </p>
    </section>
  );
}
