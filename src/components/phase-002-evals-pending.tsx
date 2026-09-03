import Link from "next/link";

export function Phase002EvalsPending() {
  return (
    <section className="phase-002-evals-panel panel" aria-labelledby="evals-heading">
      <header className="phase-002-evals-heading">
        <p className="eyebrow">Public evaluation record</p>
        <h1 id="evals-heading">Evaluation results</h1>
        <p className="lede">
          Measured provider results will be published with their corpus,
          methodology, and limitations. This page does not publish a score
          before that record exists.
        </p>
      </header>

      <div className="status status-delayed" role="status" aria-live="polite">
        <p className="status-title">Results pending</p>
        <p>
          Measured Laguna S 2.1 and Nemotron 3 Ultra precision and recall
          results will arrive in Phase 005.
        </p>
      </div>

      <div className="phase-002-evals-copy">
        <p>
          When published, the comparison will use the same versioned evaluation
          corpus and documented scoring rules for both named providers and the
          merged review path.
        </p>
        <p className="supporting-copy">
          No numbers or pass threshold are available on this pre-release page.
        </p>
      </div>

      <div className="phase-002-actions">
        <Link className="secondary-button" href="/">
          Return to SentiRev
        </Link>
        <Link className="primary-button" href="/install">
          Install GitHub App
        </Link>
      </div>
    </section>
  );
}
