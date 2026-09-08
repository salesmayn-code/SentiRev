import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DiffValidationError,
  MAX_PROVIDER_CHUNK_BYTES,
  MAX_PROVIDER_CHUNK_LINES,
  parseUnifiedDiff,
} from "../../../src/lib/review/diff";

const fixture = (name: string) =>
  readFileSync(resolve("tests/fixtures/review", name), "utf8");

function expectRejected(diff: string, code: string): void {
  try {
    parseUnifiedDiff(diff);
    throw new Error("expected the diff to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(DiffValidationError);
    expect((error as DiffValidationError).code).toBe(code);
  }
}

function expectRejectedWithOptions(
  diff: string,
  code: string,
  options: Parameters<typeof parseUnifiedDiff>[1],
): void {
  try {
    parseUnifiedDiff(diff, options);
    throw new Error("expected the diff to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(DiffValidationError);
    expect((error as DiffValidationError).code).toBe(code);
  }
}

function addedFile(filePath: string, count: number): string {
  const additions = Array.from({ length: count }, () => "+x").join("\n");
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${count} @@`,
    additions,
  ].join("\n");
}

describe("unified diff parser and chunker", () => {
  it.each([
    ["javascript-input.diff", "src/review.js", "javascript"],
    ["typescript-input.diff", "src/review.ts", "typescript"],
    ["python-input.diff", "src/review.py", "python"],
  ])("maps supported %s fixture lines to the new side", (name, filePath, language) => {
    const parsed = parseUnifiedDiff(fixture(name));

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].filePath).toBe(filePath);
    expect(parsed.files[0].language).toBe(language);
    expect(parsed.files[0].changedLineCount).toBe(2);
    expect(parsed.changedLineCount).toBe(2);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0].changedLineNumbers).toEqual([2, 3]);
    expect(parsed.chunks[0].lines.map((line) => line.newLineNumber)).toEqual([1, 2, 3, 4]);
    expect(parsed.chunks[0].lines.filter((line) => line.kind === "added").map((line) => line.content)).toHaveLength(2);
    expect(parsed.chunks[0].contextLineCount).toBeLessThanOrEqual(6);
  });

  it("keeps JSX and TSX extensions while routing them to supported Semgrep languages", () => {
    const jsx = parseUnifiedDiff(fixture("javascript-input.diff").replaceAll("review.js", "review.jsx"));
    const tsx = parseUnifiedDiff(fixture("typescript-input.diff").replaceAll("review.ts", "review.tsx"));

    expect(jsx.files[0].filePath).toBe("src/review.jsx");
    expect(jsx.files[0].language).toBe("javascript");
    expect(tsx.files[0].filePath).toBe("src/review.tsx");
    expect(tsx.files[0].language).toBe("typescript");
  });

  it("produces stable chunks and preserves every changed line at chunk boundaries", () => {
    const additions = Array.from({ length: 205 }, (_, index) => `+const value${index} = ${index};`).join("\n");
    const diff = [
      "diff --git a/src/many.ts b/src/many.ts",
      "index 1111111..2222222 100644",
      "--- a/src/many.ts",
      "+++ b/src/many.ts",
      "@@ -0,0 +1,205 @@",
      additions,
    ].join("\n");
    const first = parseUnifiedDiff(diff);
    const second = parseUnifiedDiff(diff);

    expect(first).toEqual(second);
    expect(first.chunks).toHaveLength(2);
    expect(first.chunks[0].lines).toHaveLength(MAX_PROVIDER_CHUNK_LINES);
    expect(first.chunks[1].changedLineNumbers).toEqual([201, 202, 203, 204, 205]);
    expect(first.chunks.every((chunk) => chunk.changedLineCount > 0)).toBe(true);
    expect(first.chunks.every((chunk) => chunk.byteLength <= MAX_PROVIDER_CHUNK_BYTES)).toBe(true);
    expect(first.chunks.every((chunk) => /^chunk-[a-f0-9]{64}$/u.test(chunk.id))).toBe(true);
    expect(first.changedLineCount).toBe(205);
  });

  it("enforces the changed-line limit across every file in the diff", () => {
    const atLimit = [addedFile("src/first.ts", 2), addedFile("src/second.ts", 2)].join("\n");
    const aboveLimit = [addedFile("src/first.ts", 2), addedFile("src/second.ts", 3)].join("\n");

    expect(parseUnifiedDiff(atLimit, { maxChangedLines: 4 }).changedLineCount).toBe(4);
    expectRejectedWithOptions(aboveLimit, "DIFF_TOO_LARGE", { maxChangedLines: 4 });
  });

  it("keeps only a bounded context window around a changed line", () => {
    const before = Array.from({ length: 10 }, (_, index) => ` line-${index}`).join("\n");
    const after = Array.from({ length: 10 }, (_, index) => ` after-${index}`).join("\n");
    const diff = [
      "diff --git a/src/context.js b/src/context.js",
      "--- a/src/context.js",
      "+++ b/src/context.js",
      "@@ -1,20 +1,21 @@",
      before,
      "+  dangerous(input);",
      after,
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0].contextLineCount).toBe(6);
    expect(parsed.chunks[0].lines[0].content).toBe("line-7");
    expect(parsed.chunks[0].lines.at(-1)?.content).toBe("after-2");
  });

  it("rejects traversal, absolute, and unsupported paths before execution", () => {
    const base = (path: string) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,2 @@",
      " old();",
      "+new();",
    ].join("\n");

    expectRejected(base("../escape.ts"), "UNSAFE_PATH");
    expectRejected([
      "diff --git a/src/x.ts b/src/x.ts",
      "--- /absolute/src/x.ts",
      "+++ /absolute/src/x.ts",
      "@@ -1,1 +1,2 @@",
      " old();",
      "+new();",
    ].join("\n"), "UNSAFE_PATH");
    expectRejected(base("src/module.go"), "UNSUPPORTED_LANGUAGE");
  });

  it("rejects binary, submodule, and combined patches", () => {
    expectRejected([
      "diff --git a/src/image.ts b/src/image.ts",
      "new file mode 100644",
      "Binary files /dev/null and b/src/image.ts differ",
    ].join("\n"), "BINARY_PATCH");
    expectRejected([
      "diff --git a/vendor b/vendor",
      "old mode 160000",
      "new mode 160000",
      "Subproject commit 1111111111111111111111111111111111111111",
    ].join("\n"), "SUBMODULE_PATCH");
    expectRejected([
      "diff --cc src/review.ts",
      "--- a/src/review.ts",
      "+++ b/src/review.ts",
      "@@@ -1,1 -1,1 +1,1 @@@",
      "+new();",
    ].join("\n"), "UNSUPPORTED_DIFF");
  });

  it("rejects malformed hunk counts and invalid body markers", () => {
    expectRejected([
      "diff --git a/src/review.ts b/src/review.ts",
      "--- a/src/review.ts",
      "+++ b/src/review.ts",
      "@@ -1,1 +1,3 @@",
      " old();",
      "+new();",
    ].join("\n"), "MALFORMED_HUNK");
    expectRejected([
      "diff --git a/src/review.ts b/src/review.ts",
      "--- a/src/review.ts",
      "+++ b/src/review.ts",
      "@@ -1,1 +1,1 @@",
      "?not-a-diff-line",
    ].join("\n"), "MALFORMED_HUNK");
  });

  it("rejects unbounded input and changed-line counts", () => {
    expect(() => parseUnifiedDiff(fixture("javascript-input.diff"), { maxDiffBytes: 4 })).toThrowError(DiffValidationError);
    expect(() => parseUnifiedDiff(fixture("javascript-input.diff"), { maxChangedLines: 1 })).toThrowError(DiffValidationError);
  });
});
