import { AnnotatedGutter } from "@/components/annotated-gutter";
import { Phase002LandingProof } from "@/components/phase-002-landing-proof";
import { SiteHeader } from "@/components/site-header";

export default function PublicHomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="public-main phase-002-home-main">
        <div className="annotated-layout annotated-layout-wide phase-002-layout">
          <AnnotatedGutter index="00" label="Public review proof rail" />
          <div className="reading-column">
            <Phase002LandingProof />
          </div>
          <aside className="annotation-column phase-002-margin-note" aria-label="Review proof notes">
            <p className="eyebrow">Review rail</p>
            <p className="supporting-copy">
              One finding, one citation, and one explicit data boundary. The
              source and engine are named so the example can be checked.
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
