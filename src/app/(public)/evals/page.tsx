import { AnnotatedGutter } from "@/components/annotated-gutter";
import { Phase002EvalsPending } from "@/components/phase-002-evals-pending";
import { SiteHeader } from "@/components/site-header";

export default function PublicEvalsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="public-main phase-002-evals-main">
        <div className="annotated-layout annotated-layout-wide phase-002-layout">
          <AnnotatedGutter index="03" label="Public evaluation rail" />
          <div className="reading-column">
            <Phase002EvalsPending />
          </div>
          <aside className="annotation-column phase-002-margin-note" aria-label="Evaluation notes">
            <p className="eyebrow">Evidence ledger</p>
            <p className="supporting-copy">
              Provider values belong to the versioned evaluation record. Until
              Phase 005, this page reports the absence of published results.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
