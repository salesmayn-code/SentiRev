import {
  normalizedFindingFingerprint,
  parseReviewFinding,
  severityRank,
  type ReviewFinding,
  type ReviewProvenance,
} from "@/lib/review/schema";

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.category.localeCompare(right.category) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    severityRank(right.severity) - severityRank(left.severity) ||
    left.summary.localeCompare(right.summary) ||
    left.reasoning.localeCompare(right.reasoning)
  );
}

function touches(left: ReviewFinding, right: ReviewFinding): boolean {
  return left.filePath === right.filePath
    && left.category === right.category
    && left.startLine <= right.endLine + 1
    && right.startLine <= left.endLine + 1;
}

function uniqueProvenance(provenance: ReviewProvenance[]): ReviewProvenance[] {
  return [...new Map(provenance.map((item) => [
    `${item.engineKind}:${item.engineIdentifier}:${item.staticRuleId ?? ""}`,
    item,
  ])).values()].sort((left, right) => (
    left.engineKind.localeCompare(right.engineKind)
    || left.engineIdentifier.localeCompare(right.engineIdentifier)
    || (left.staticRuleId ?? "").localeCompare(right.staticRuleId ?? "")
  ));
}

/**
 * Merges only same-category locations that overlap or touch. The sort and
 * grouping are deterministic, so input engine completion order cannot change
 * the persisted result.
 */
export function mergeReviewFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const sorted = [...findings].sort(compareFindings);
  const merged: ReviewFinding[] = [];

  for (let index = 0; index < sorted.length;) {
    const group = [sorted[index]];
    let groupEnd = sorted[index].endLine;
    index += 1;

    while (index < sorted.length) {
      const candidate = sorted[index];
      const prior = group[group.length - 1];
      if (candidate.filePath !== prior.filePath || candidate.category !== prior.category || candidate.startLine > groupEnd + 1) {
        break;
      }
      group.push(candidate);
      groupEnd = Math.max(groupEnd, candidate.endLine);
      index += 1;
    }

    const representative = [...group].sort((left, right) => (
      severityRank(right.severity) - severityRank(left.severity)
      || compareFindings(left, right)
    ))[0];
    const startLine = Math.min(...group.map((item) => item.startLine));
    const endLine = Math.max(...group.map((item) => item.endLine));
    const mergedInput = {
      ...representative,
      startLine,
      endLine,
      provenance: uniqueProvenance(group.flatMap((item) => item.provenance)),
    };
    const parsed = parseReviewFinding(mergedInput);
    merged.push({ ...parsed, fingerprint: normalizedFindingFingerprint(parsed) });
  }

  return merged.sort(compareFindings);
}

export function findingsTouch(left: ReviewFinding, right: ReviewFinding): boolean {
  return touches(left, right);
}
