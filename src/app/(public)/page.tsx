import Link from "next/link";

import { AnnotatedGutter } from "@/components/annotated-gutter";
import { SiteHeader } from "@/components/site-header";

export default function PublicHomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="public-main">
        <div className="annotated-layout annotated-layout-wide">
          <AnnotatedGutter
            index="00"
            label="Public connection overview"
          />
          <div className="reading-column flow-stack">
            <section className="intro-stack" aria-labelledby="public-heading">
              <p className="eyebrow">GitHub connection / Phase 001</p>
              <h1 id="public-heading">A clear boundary before review work begins</h1>
              <p className="lede">
                SentiRev connects to a GitHub repository through an
                administrator-approved installation. Start by choosing whether
                the repository may use named AI providers later, or remain
                static-only.
              </p>
              <div className="form-actions">
                <Link className="primary-button" href="/install">
                  Install GitHub App
                </Link>
              </div>
            </section>

            <section id="data-use" className="flow-stack-tight" aria-labelledby="data-use-heading">
              <div className="section-rule" aria-hidden="true" />
              <div className="intro-stack">
                <p className="eyebrow">Data boundary</p>
                <h2 id="data-use-heading">What this connection sees</h2>
                <p className="prose">
                  The first connection records the GitHub identity, App
                  installation, selected repository metadata, and signed
                  webhook metadata needed to identify new pull requests.
                </p>
              </div>
              <ul className="data-list">
                <li>
                  <span className="mono">Repository metadata</span>
                  <span className="supporting-copy">
                    The repository name, owner, installation relationship, and
                    connection state are retained so the dashboard can show the
                    repository immediately.
                  </span>
                </li>
                <li>
                  <span className="mono">Webhook metadata</span>
                  <span className="supporting-copy">
                    A signed delivery identity and pull-request event metadata
                    are retained for durable queued work.
                  </span>
                </li>
                <li>
                  <span className="mono">Pull-request diff</span>
                  <span className="supporting-copy">
                    Phase 001 does not send or analyze a diff. No finding or
                    review comment is created by this connection screen.
                  </span>
                </li>
              </ul>
            </section>

            <section className="panel install-panel" aria-labelledby="next-step-heading">
              <div className="intro-stack">
                <p className="eyebrow">Next step</p>
                <h2 id="next-step-heading">Choose the processing mode</h2>
                <p>
                  The install page explains the two consent modes and sends you
                  to GitHub&apos;s App installation flow.
                </p>
              </div>
              <div className="form-actions">
                <Link className="primary-button" href="/install">
                  Continue to install
                </Link>
              </div>
            </section>
          </div>
          <aside className="annotation-column" aria-label="Connection notes">
            <p className="eyebrow">Boundary notes</p>
            <p className="supporting-copy">
              Admin permission is required. The repository user never enters an
              AI-provider API key.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
