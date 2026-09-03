import type { ReactNode } from "react";

type GutterTone = "default" | "success" | "error";

type AnnotatedGutterProps = {
  index: string;
  label: string;
  tone?: GutterTone;
  children?: ReactNode;
};

export function AnnotatedGutter({
  index,
  label,
  tone = "default",
  children,
}: AnnotatedGutterProps) {
  return (
    <aside className="gutter-rail" aria-label={label}>
      <span className="gutter-index">{index}</span>
      <span
        aria-hidden="true"
        className={`gutter-tick gutter-tick-${tone}`}
      />
      {children}
    </aside>
  );
}
