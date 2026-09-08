import { createHash } from "node:crypto";

import { isRepositoryRelativePath } from "./schema";

export const MAX_PROVIDER_CHUNK_LINES = 200;
export const MAX_PROVIDER_CHUNK_BYTES = 24 * 1024;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_LINES = 100_000;
export const MAX_CHANGED_LINES = 50_000;
export const MAX_CONTEXT_LINES = 3;

export type DiffLanguage = "javascript" | "typescript" | "python";
export type DiffLineKind = "added" | "context";

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  newLineNumber: number;
};

export type DiffChunk = {
  id: string;
  filePath: string;
  language: DiffLanguage;
  hunkIndex: number;
  segmentIndex: number;
  lines: readonly DiffLine[];
  text: string;
  changedLineNumbers: readonly number[];
  changedLineCount: number;
  contextLineCount: number;
  startLine: number;
  endLine: number;
  byteLength: number;
};

export type UnifiedDiffFile = {
  filePath: string;
  language: DiffLanguage;
  status: "added" | "modified" | "deleted" | "renamed";
  changedLineCount: number;
  hunkCount: number;
  chunks: readonly DiffChunk[];
};

export type ParsedUnifiedDiff = {
  files: readonly UnifiedDiffFile[];
  chunks: readonly DiffChunk[];
  changedLineCount: number;
  changedFileCount: number;
  inputBytes: number;
};

export type DiffParserOptions = {
  maxDiffBytes?: number;
  maxDiffLines?: number;
  maxChangedLines?: number;
  contextLines?: number;
  maxChunkLines?: number;
  maxChunkBytes?: number;
};

export class DiffValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DiffValidationError";
    this.code = code;
  }
}

type HunkLine = DiffLine & { sourceIndex: number };

type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
};

type MutableFile = {
  oldPath?: string;
  newPath?: string;
  oldHeaderSeen: boolean;
  newHeaderSeen: boolean;
  hunks: ParsedHunk[];
  metadataSeen: Set<string>;
};

const SUPPORTED_EXTENSIONS: Readonly<Record<string, DiffLanguage>> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
};

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function fail(code: string, message: string): never {
  throw new DiffValidationError(code, message);
}

function languageForPath(filePath: string): DiffLanguage {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const language = SUPPORTED_EXTENSIONS[extension];
  if (!language) {
    fail("UNSUPPORTED_LANGUAGE", "The diff contains an unsupported file type");
  }
  return language;
}

function validatePath(rawPath: string): string | null {
  const path = rawPath;
  if (path === "/dev/null") return null;
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment.length === 0) ||
    !isRepositoryRelativePath(path)
  ) {
    fail("UNSAFE_PATH", "The diff contains an unsafe repository path");
  }
  return path;
}

function pathFromHeader(line: string, prefix: "--- " | "+++ "): string | null {
  if (!line.startsWith(prefix)) {
    fail("MALFORMED_HEADER", "The diff is missing a file path header");
  }
  const value = line.slice(prefix.length).split("\t", 1)[0];
  if (value === "/dev/null") return null;
  const withoutGitPrefix = value.startsWith("a/") || value.startsWith("b/")
    ? value.slice(2)
    : value;
  return validatePath(withoutGitPrefix);
}

function parseGitHeader(line: string): void {
  if (!/^diff --git a\/.+ b\/.+$/.test(line)) {
    fail("MALFORMED_HEADER", "The diff contains an invalid git file header");
  }
}

function parseHunkHeader(line: string): Omit<ParsedHunk, "lines"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
  if (!match) {
    fail("MALFORMED_HUNK", "The diff contains an invalid hunk header");
  }

  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (
    !Number.isSafeInteger(oldStart) ||
    !Number.isSafeInteger(oldCount) ||
    !Number.isSafeInteger(newStart) ||
    !Number.isSafeInteger(newCount) ||
    oldCount < 0 ||
    newCount < 0 ||
    (oldCount > 0 && oldStart < 1) ||
    (newCount > 0 && newStart < 1)
  ) {
    fail("MALFORMED_HUNK", "The diff contains invalid hunk line counts");
  }
  return { oldStart, oldCount, newStart, newCount };
}

function isMetadataLine(line: string): boolean {
  return /^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line);
}

function parseFileBlock(lines: readonly string[], start: number): { file: MutableFile; next: number } {
  let index = start;
  const file: MutableFile = {
    hunks: [],
    metadataSeen: new Set<string>(),
    oldHeaderSeen: false,
    newHeaderSeen: false,
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      break;
    }
    if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
      fail("BINARY_PATCH", "Binary patches are not supported");
    }
    if (line.startsWith("Subproject commit ")) {
      fail("SUBMODULE_PATCH", "Submodule patches are not supported");
    }
    if (line.startsWith("--- ")) {
      if (file.oldHeaderSeen) fail("MALFORMED_HEADER", "The diff repeats the old-file header");
      file.oldHeaderSeen = true;
      file.oldPath = pathFromHeader(line, "--- ") ?? undefined;
      index += 1;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (file.newHeaderSeen) fail("MALFORMED_HEADER", "The diff repeats the new-file header");
      file.newHeaderSeen = true;
      file.newPath = pathFromHeader(line, "+++ ") ?? undefined;
      index += 1;
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!file.oldHeaderSeen && !file.newHeaderSeen) {
        fail("MALFORMED_HEADER", "The diff hunk has no file path");
      }
      const hunkHeader = parseHunkHeader(line);
      index += 1;
      const hunkLines: HunkLine[] = [];
      let oldConsumed = 0;
      let newConsumed = 0;
      let newLine = hunkHeader.newStart;
      let sawContent = false;
      let sawNoNewlineMarker = false;

      while (index < lines.length) {
        const bodyLine = lines[index];
        if (
          bodyLine.startsWith("diff --git ") ||
          bodyLine.startsWith("diff --cc ") ||
          bodyLine.startsWith("diff --combined ") ||
          bodyLine.startsWith("--- ") ||
          bodyLine.startsWith("+++ ") ||
          bodyLine.startsWith("@@ ")
        ) {
          break;
        }
        if (bodyLine === NO_NEWLINE_MARKER) {
          if (!sawContent || sawNoNewlineMarker) {
            fail("MALFORMED_HUNK", "The no-newline marker is out of place");
          }
          sawNoNewlineMarker = true;
          index += 1;
          continue;
        }

        const marker = bodyLine[0];
        if (marker !== " " && marker !== "+" && marker !== "-") {
          fail("MALFORMED_HUNK", "The diff contains an invalid hunk line");
        }
        sawContent = true;
        if (marker === " " || marker === "+") {
          if (newConsumed >= hunkHeader.newCount) {
            fail("MALFORMED_HUNK", "The hunk contains too many new-side lines");
          }
          hunkLines.push({
            kind: marker === "+" ? "added" : "context",
            content: bodyLine.slice(1),
            newLineNumber: newLine,
            sourceIndex: index,
          });
          newConsumed += 1;
          newLine += 1;
        }
        if (marker === " " || marker === "-") {
          if (oldConsumed >= hunkHeader.oldCount) {
            fail("MALFORMED_HUNK", "The hunk contains too many old-side lines");
          }
          oldConsumed += 1;
        }
        index += 1;
      }

      if (oldConsumed !== hunkHeader.oldCount || newConsumed !== hunkHeader.newCount) {
        fail("MALFORMED_HUNK", "The hunk line counts do not match its body");
      }
      file.hunks.push({ ...hunkHeader, lines: hunkLines });
      continue;
    }
    if (isMetadataLine(line) || line === "") {
      if (line !== "") file.metadataSeen.add(line.split(" ", 1)[0]);
      index += 1;
      continue;
    }
    fail("MALFORMED_DIFF", "The diff contains unexpected file metadata");
  }

  if (!file.oldHeaderSeen && !file.newHeaderSeen) {
    fail("MALFORMED_HEADER", "The diff file has no repository path");
  }
  return { file, next: index };
}

function normalizeFilePath(file: MutableFile): { filePath: string; status: UnifiedDiffFile["status"] } {
  const filePath = file.newPath ?? file.oldPath;
  if (!filePath) fail("MALFORMED_HEADER", "The diff has no usable file path");
  // Validate both sides. This rejects an unsafe old path even when a rename
  // points at a safe new path.
  validatePath(file.oldPath ?? "/dev/null");
  validatePath(file.newPath ?? "/dev/null");
  languageForPath(filePath);
  const status: UnifiedDiffFile["status"] =
    !file.oldHeaderSeen
      ? "added"
      : !file.newHeaderSeen
        ? "deleted"
        : file.oldPath === file.newPath
          ? "modified"
          : "renamed";
  return { filePath, status };
}

function selectedHunkLines(hunk: ParsedHunk, contextLines: number): HunkLine[] {
  const changedIndexes = hunk.lines
    .map((line, index) => (line.kind === "added" ? index : -1))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return [];

  const selected = new Set<number>();
  for (const changedIndex of changedIndexes) {
    const from = Math.max(0, changedIndex - contextLines);
    const to = Math.min(hunk.lines.length - 1, changedIndex + contextLines);
    for (let index = from; index <= to; index += 1) {
      if (hunk.lines[index].kind === "added" || index <= changedIndex + contextLines) {
        selected.add(index);
      }
    }
  }
  return [...selected].sort((left, right) => left - right).map((index) => hunk.lines[index]);
}

function splitIntoChunks(
  filePath: string,
  language: DiffLanguage,
  hunkIndex: number,
  lines: readonly HunkLine[],
  options: Required<Pick<DiffParserOptions, "maxChunkLines" | "maxChunkBytes">>,
): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let current: HunkLine[] = [];
  let currentBytes = 0;
  let segmentIndex = 0;
  let previousLineNumber: number | undefined;

  const flush = () => {
    if (current.length === 0) return;
    if (!current.some((line) => line.kind === "added")) {
      current = [];
      currentBytes = 0;
      return;
    }
    const text = current.map((line) => line.content).join("\n");
    const byteLength = Buffer.byteLength(`${text}\n`, "utf8");
    const changedLineNumbers = current
      .filter((line) => line.kind === "added")
      .map((line) => line.newLineNumber);
    // Provider chunk IDs are opaque identifiers. Keep repository paths in the
    // dedicated filePath field and emit only characters accepted by the
    // provider boundary. The full digest keeps IDs stable and collision-safe
    // across files, hunks, and segments without exposing path syntax.
    const id = `chunk-${createHash("sha256")
      .update(`${filePath}\0${hunkIndex}\0${segmentIndex}`)
      .digest("hex")}`;
    chunks.push({
      id,
      filePath,
      language,
      hunkIndex,
      segmentIndex,
      lines: current.map(({ sourceIndex: _sourceIndex, ...line }) => line),
      text,
      changedLineNumbers,
      changedLineCount: changedLineNumbers.length,
      contextLineCount: current.filter((line) => line.kind === "context").length,
      startLine: current[0].newLineNumber,
      endLine: current[current.length - 1].newLineNumber,
      byteLength,
    });
    segmentIndex += 1;
    current = [];
    currentBytes = 0;
    previousLineNumber = undefined;
  };

  for (const line of lines) {
    const gapExceedsContextWindow =
      previousLineNumber !== undefined &&
      line.newLineNumber > previousLineNumber + MAX_CONTEXT_LINES * 2 + 1;
    if (gapExceedsContextWindow) flush();
    const lineBytes = Buffer.byteLength(line.content, "utf8") + 1;
    if (lineBytes > options.maxChunkBytes) {
      fail("CHUNK_TOO_LARGE", "A changed line exceeds the provider chunk byte limit");
    }
    const wouldExceedLines = current.length >= options.maxChunkLines;
    const wouldExceedBytes = current.length > 0 && currentBytes + lineBytes > options.maxChunkBytes;
    if (wouldExceedLines || wouldExceedBytes) flush();
    current.push(line);
    currentBytes += lineBytes;
    previousLineNumber = line.newLineNumber;
  }
  flush();
  return chunks;
}

function parseSingleDiff(input: string, options: Required<Pick<DiffParserOptions, "maxDiffBytes" | "maxDiffLines" | "maxChangedLines" | "contextLines" | "maxChunkLines" | "maxChunkBytes">>): ParsedUnifiedDiff {
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes > options.maxDiffBytes) fail("DIFF_TOO_LARGE", "The unified diff exceeds the input byte limit");
  const lines = input.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.length > options.maxDiffLines) {
    fail("DIFF_TOO_LARGE", "The unified diff exceeds the input line limit");
  }

  const files: UnifiedDiffFile[] = [];
  const chunks: DiffChunk[] = [];
  const seenPaths = new Set<string>();
  let totalChangedLineCount = 0;
  let index = 0;
  while (index < lines.length) {
    if (lines[index].startsWith("diff --git ")) {
      parseGitHeader(lines[index]);
      index += 1;
    } else if (lines[index].startsWith("diff --cc ") || lines[index].startsWith("diff --combined ")) {
      fail("UNSUPPORTED_DIFF", "Combined diffs are not supported");
    } else if (files.length === 0 && lines[index].startsWith("--- ")) {
      // Accept a single standard unified diff without the optional git header.
    } else {
      fail("MALFORMED_DIFF", "The diff must begin with a git or unified file header");
    }

    const parsed = parseFileBlock(lines, index);
    index = parsed.next;
    const normalized = normalizeFilePath(parsed.file);
    if (seenPaths.has(normalized.filePath)) fail("DUPLICATE_PATH", "The diff repeats a repository path");
    seenPaths.add(normalized.filePath);
    const language = languageForPath(normalized.filePath);
    const fileChunks: DiffChunk[] = [];
    let changedLineCount = 0;
    parsed.file.hunks.forEach((hunk, hunkIndex) => {
      const selected = selectedHunkLines(hunk, options.contextLines);
      const hunkChunks = splitIntoChunks(
        normalized.filePath,
        language,
        hunkIndex,
        selected,
        options,
      );
      fileChunks.push(...hunkChunks);
      const hunkChangedLineCount = hunkChunks.reduce(
        (sum, chunk) => sum + chunk.changedLineCount,
        0,
      );
      changedLineCount += hunkChangedLineCount;
      totalChangedLineCount += hunkChangedLineCount;
      if (totalChangedLineCount > options.maxChangedLines) {
        fail("DIFF_TOO_LARGE", "The unified diff exceeds the changed-line limit");
      }
    });
    files.push({
      filePath: normalized.filePath,
      language,
      status: normalized.status,
      changedLineCount,
      hunkCount: parsed.file.hunks.length,
      chunks: fileChunks,
    });
    chunks.push(...fileChunks);
  }

  return {
    files,
    chunks,
    changedLineCount: totalChangedLineCount,
    changedFileCount: files.filter((file) => file.changedLineCount > 0).length,
    inputBytes,
  };
}

export function parseUnifiedDiff(input: string, options: DiffParserOptions = {}): ParsedUnifiedDiff {
  if (typeof input !== "string") fail("INVALID_INPUT", "The unified diff must be text");
  const resolvedOptions = {
    maxDiffBytes: options.maxDiffBytes ?? MAX_DIFF_BYTES,
    maxDiffLines: options.maxDiffLines ?? MAX_DIFF_LINES,
    maxChangedLines: options.maxChangedLines ?? MAX_CHANGED_LINES,
    contextLines: options.contextLines ?? MAX_CONTEXT_LINES,
    maxChunkLines: options.maxChunkLines ?? MAX_PROVIDER_CHUNK_LINES,
    maxChunkBytes: options.maxChunkBytes ?? MAX_PROVIDER_CHUNK_BYTES,
  };
  if (
    !Number.isSafeInteger(resolvedOptions.maxDiffBytes) ||
    resolvedOptions.maxDiffBytes < 1 ||
    !Number.isSafeInteger(resolvedOptions.maxDiffLines) ||
    resolvedOptions.maxDiffLines < 1 ||
    !Number.isSafeInteger(resolvedOptions.maxChangedLines) ||
    resolvedOptions.maxChangedLines < 1 ||
    !Number.isSafeInteger(resolvedOptions.contextLines) ||
    resolvedOptions.contextLines < 0 ||
    resolvedOptions.contextLines > MAX_CONTEXT_LINES ||
    resolvedOptions.maxChunkLines < 1 ||
    resolvedOptions.maxChunkLines > MAX_PROVIDER_CHUNK_LINES ||
    resolvedOptions.maxChunkBytes < 1 ||
    resolvedOptions.maxChunkBytes > MAX_PROVIDER_CHUNK_BYTES
  ) {
    fail("INVALID_OPTIONS", "The diff bounds are outside the Phase 003 limits");
  }
  return parseSingleDiff(input, resolvedOptions);
}

export const parseDiff = parseUnifiedDiff;
