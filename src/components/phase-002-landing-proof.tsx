import Link from "next/link";

const citedLines = [
  {
    number: 19,
    content:
      "export function exportAdminReport(user: RepositoryUser | null): AdminReport {",
  },
  { number: 20, content: "  if (!user) {" },
  { number: 21, content: '    throw new Error("Authentication required");' },
  { number: 22, content: "  }" },
  { number: 23, content: "" },
  { number: 24, content: "  return buildAdminReport(user.id);", cited: true },
];

export function Phase002LandingProof() {
  return (
    <div className="phase-002-landing-proof">
      <section id="how-it-works" className="phase-002-intro" aria-labelledby="public-heading">
        <p className="eyebrow">GitHub pull requests / annotated review</p>
        <h1 id="public-heading">A careful second review for every pull request.</h1>
        <p className="lede">
          SentiRev checks the change for security and logic issues, then explains
          each finding at the line where it matters. Findings are advisory; your
          team keeps control of the merge.
        </p>

        <div className="phase-002-action-row">
          <div className="phase-002-actions">
            <Link className="primary-button" href="/install">
              Install GitHub App
            </Link>
            <Link className="secondary-button" href="/evals">
              View evaluation status
            </Link>
          </div>
          <p className="supporting-copy">
            GitHub repository administrators install the App. AI processing is
            disclosed and optional during connection.
          </p>
        </div>

        <div className="phase-002-overview-grid">
          <section className="phase-002-overview-section" aria-labelledby="checks-heading">
            <p className="eyebrow">Review focus</p>
            <h2 id="checks-heading">What it checks</h2>
            <ul className="phase-002-check-list">
              <li>
                <span className="phase-002-list-index" aria-hidden="true">01</span>
                <span>Authorization bypasses</span>
              </li>
              <li>
                <span className="phase-002-list-index" aria-hidden="true">02</span>
                <span>Unsanitized input</span>
              </li>
              <li>
                <span className="phase-002-list-index" aria-hidden="true">03</span>
                <span>Committed secrets</span>
              </li>
              <li>
                <span className="phase-002-list-index" aria-hidden="true">04</span>
                <span>Unsafe deserialization</span>
              </li>
            </ul>
          </section>

          <section className="phase-002-overview-section" aria-labelledby="data-boundary-heading">
            <p className="eyebrow">Data boundary</p>
            <h2 id="data-boundary-heading">What it sees</h2>
            <dl className="phase-002-data-list">
              <div>
                <dt>Pull-request diff</dt>
                <dd>
                  Changed hunks with bounded context. Raw diff text is deleted
                  after analysis; full source files are not sent.
                </dd>
              </div>
              <div>
                <dt>Repository metadata</dt>
                <dd>
                  Repository identity and event metadata route the review and
                  keep the connected repository visible in the dashboard.
                </dd>
              </div>
              <div>
                <dt>Structured finding</dt>
                <dd>
                  A small cited snippet and explanation remain until the
                  repository admin deletes the review history.
                </dd>
              </div>
            </dl>
          </section>
        </div>

      </section>

      <Phase002FindingProof />
    </div>
  );
}

function Phase002FindingProof() {
  return (
    <article className="phase-002-proof-panel panel" aria-labelledby="finding-heading">
      <header className="phase-002-proof-heading">
        <div className="phase-002-proof-title">
          <p className="eyebrow">Representative finding</p>
          <h2 id="finding-heading">Authorization bypass</h2>
        </div>
        <span className="phase-002-severity">
          <span className="phase-002-severity-tick" aria-hidden="true" />
          High
        </span>
      </header>

      <p className="phase-002-finding-summary">
        An authenticated user can export an administrator report without an
        administrator-role check.
      </p>

      <div className="phase-002-finding-citation">
        <div>
          <p className="eyebrow">Cited location</p>
          <a
            className="mono phase-002-source-link"
            href="https://github.com/salesmayn-code/sentirev-test-repo/blob/3f17c37f7c9ef55bf4dc10231da9cdb6e4857868/src/api/admin/export-report.ts#L24"
            rel="noreferrer"
            target="_blank"
          >
            src/api/admin/export-report.ts:24
          </a>
        </div>
        <div>
          <p className="eyebrow">Review source</p>
          <p className="mono phase-002-source-copy">
            salesmayn-code/sentirev-test-repo / PR #2
          </p>
          <p className="mono phase-002-source-copy">
            Commit 3f17c37f7c9ef55bf4dc10231da9cdb6e4857868
          </p>
        </div>
      </div>

      <div
        className="phase-002-code-scroll"
        role="region"
        aria-labelledby="cited-code-heading"
        tabIndex={0}
      >
        <p id="cited-code-heading" className="phase-002-code-label">
          Selectable excerpt / lines 19–24
        </p>
        <ol className="phase-002-code-lines">
          {citedLines.map((line) => (
            <li
              className={line.cited ? "phase-002-code-line phase-002-code-line-cited" : "phase-002-code-line"}
              key={line.number}
            >
              <span className="phase-002-line-number">{line.number}</span>
              <code>{line.content || " "}</code>
            </li>
          ))}
        </ol>
      </div>

      <details className="phase-002-reasoning">
        <summary>Show reasoning</summary>
        <div className="phase-002-reasoning-copy">
          <p>
            Authentication is checked for a non-null user on lines 19–22, but
            the handler then returns the administrator report on line 24. A
            separate administrator-role check is needed before this operation.
          </p>
        </div>
      </details>

      <div className="phase-002-engine-row">
        <p className="eyebrow">Engine</p>
        <p className="mono">Laguna S 2.1 — representative output</p>
      </div>

      <aside className="phase-002-proof-disclosure" aria-label="Representative proof disclosure">
        <p className="eyebrow">Pre-release disclosure</p>
        <p>
          This is manually prepared representative proof from the controlled
          test repository. It is not produced by the current SentiRev pipeline
          and is not an evaluation result.
        </p>
      </aside>
    </article>
  );
}
