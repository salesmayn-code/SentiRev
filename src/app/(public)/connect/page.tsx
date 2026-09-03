import { AnnotatedGutter } from "@/components/annotated-gutter";
import {
  ConnectFlow,
  type ConsentMode,
} from "@/components/install-flow";
import { SiteHeader } from "@/components/site-header";

type SearchParams = Promise<{
  consentMode?: string;
  error?: string;
  installation_id?: string;
}>;

type ConnectPageProps = {
  searchParams?: SearchParams;
};

function getMode(mode: string | undefined): ConsentMode {
  return mode === "static" ? "static" : "ai";
}

function isInstallationId(value: string | undefined): value is string {
  return Boolean(value && /^\d+$/u.test(value));
}

export default async function ConnectPage({ searchParams }: ConnectPageProps) {
  const params = searchParams ? await searchParams : {};

  return (
    <>
      <SiteHeader />
      <main id="main-content" className="public-main">
        <div className="annotated-layout annotated-layout-wide">
          <AnnotatedGutter
            index="01"
            label="Repository selection and consent step"
            tone={params.error ? "error" : "default"}
          />
          <div className="reading-column">
            {isInstallationId(params.installation_id) ? (
              <ConnectFlow
                installationId={params.installation_id}
                initialMode={getMode(params.consentMode)}
                initialError={params.error}
              />
            ) : (
              <section className="state-region state-region-error" role="alert">
                <p className="state-label">Installation boundary</p>
                <h1>Installation details are missing</h1>
                <p>
                  GitHub did not return a usable installation identifier. No
                  repository was marked as connected; start the installation
                  again.
                </p>
                <div className="form-actions">
                  <a className="primary-button" href="/install">
                    Retry installation
                  </a>
                  <a className="secondary-button" href="/">
                    Return to SentiRev
                  </a>
                </div>
              </section>
            )}
          </div>
          <aside className="annotation-column" aria-label="Repository selection notes">
            <p className="eyebrow">Connection notes</p>
            <p className="supporting-copy">
              Select only repositories where GitHub confirms administrator
              permission. The processing choice remains visible while loading
              or retrying.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
