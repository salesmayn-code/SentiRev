import { AnnotatedGutter } from "@/components/annotated-gutter";
import {
  InstallFlow,
  type ConsentMode,
  type InstallState,
} from "@/components/install-flow";
import { SiteHeader } from "@/components/site-header";

type SearchParams = Promise<{
  consentMode?: string;
  error?: string;
}>;

type InstallPageProps = {
  searchParams?: SearchParams;
};

function getMode(mode: string | undefined): ConsentMode {
  return mode === "static" ? "static" : "ai";
}

function getState(error: string | undefined): InstallState {
  if (error) return "error";
  return "idle";
}

export default async function InstallPage({ searchParams }: InstallPageProps) {
  const params = searchParams ? await searchParams : {};
  const initialMode = getMode(params.consentMode);
  const initialState = getState(params.error);

  return (
    <>
      <SiteHeader />
      <main id="main-content" className="public-main">
        <div className="annotated-layout annotated-layout-wide">
          <AnnotatedGutter
            index="01"
            label="Installation and consent step"
          />
          <div className="reading-column">
            <InstallFlow
              initialMode={initialMode}
              initialState={initialState}
              initialError={params.error}
            />
          </div>
          <aside className="annotation-column" aria-label="Installation notes">
            <p className="eyebrow">Connection notes</p>
            <p className="supporting-copy">
              GitHub confirms repository administrator access and registers the
              webhook as part of the installation.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
