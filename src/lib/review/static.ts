import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  isRepositoryRelativePath,
  parseReviewFinding,
  type ReviewFinding,
  type ReviewSeverity,
} from "./schema";
import {
  MAX_PROVIDER_CHUNK_BYTES,
  MAX_PROVIDER_CHUNK_LINES,
  type DiffChunk,
  type DiffLanguage,
} from "./diff";

export const SENTIREV_SEMGREP_CONFIG = "config/semgrep/sentirev.yml";
export const DEFAULT_SEMGREP_TIMEOUT_MS = 60_000;
export const DEFAULT_SEMGREP_OUTPUT_BYTES = 4 * 1024 * 1024;

export type StaticAnalysisStatus = "COMPLETED";

export type StaticAnalysisResult = {
  engineKind: "STATIC";
  engineIdentifier: string;
  semgrepVersion: string;
  status: StaticAnalysisStatus;
  findings: readonly ReviewFinding[];
  durationMs: number;
  findingCount: number;
};

export type SemgrepRunnerOptions = {
  executable?: string;
  configPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  signal?: AbortSignal;
  /** A test-only dependency seam. Production callers should leave this unset. */
  spawnProcess?: SpawnProcess;
  /** A test-only version override; production records the CLI version. */
  semgrepVersion?: string;
};

export class SemgrepExecutionError extends Error {
  readonly code:
    | "SPAWN_FAILED"
    | "TIMEOUT"
    | "CANCELLED"
    | "OUTPUT_TOO_LARGE"
    | "NONZERO_EXIT"
    | "INVALID_JSON"
    | "INVALID_RESULT"
    | "VERSION_FAILED";
  readonly exitCode?: number | null;

  constructor(
    code: SemgrepExecutionError["code"],
    message: string,
    exitCode?: number | null,
  ) {
    super(message);
    this.name = "SemgrepExecutionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

type SpawnedProcess = ChildProcess & {
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
};

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

type ProcessResult = {
  stdout: string;
  exitCode: number | null;
};

type SemgrepResult = {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown };
  end?: { line?: unknown };
  extra?: {
    message?: unknown;
    severity?: unknown;
    lines?: unknown;
    metadata?: unknown;
  };
};

type SemgrepJson = {
  results?: unknown;
  errors?: unknown;
};

const LANGUAGE_EXTENSIONS: Readonly<Record<DiffLanguage, string>> = {
  javascript: ".js",
  typescript: ".ts",
  python: ".py",
};

const SUPPORTED_EXTENSIONS: Readonly<Record<DiffLanguage, readonly string[]>> = {
  javascript: [".js", ".jsx"],
  typescript: [".ts", ".tsx"],
  python: [".py"],
};

function temporaryExtensionForChunk(chunk: DiffChunk): string {
  const sourceExtension = extname(chunk.filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[chunk.language].includes(sourceExtension)
    ? sourceExtension
    : LANGUAGE_EXTENSIONS[chunk.language];
}

function safeErrorMessage(code: SemgrepExecutionError["code"]): string {
  return `Semgrep ${code.toLowerCase().replaceAll("_", " ")}`;
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): SpawnedProcess {
  return spawn(command, [...args], options) as SpawnedProcess;
}

function captureProcess(
  executable: string,
  args: readonly string[],
  options: Required<Pick<SemgrepRunnerOptions, "timeoutMs" | "maxOutputBytes">> & {
    cwd?: string;
    signal?: AbortSignal;
    spawnProcess: SpawnProcess;
    errorCode: "VERSION_FAILED" | "SPAWN_FAILED";
  },
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolveProcess, rejectProcess) => {
    let child: SpawnedProcess;
    try {
      child = options.spawnProcess(executable, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectProcess(new SemgrepExecutionError(options.errorCode, safeErrorMessage(options.errorCode)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };
    const settle = (error?: SemgrepExecutionError, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectProcess(error);
      else resolveProcess(result as ProcessResult);
    };
    const terminate = (reason: "timeout" | "cancelled" | "output") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "cancelled") cancelled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the check and kill call.
      }
      const code = reason === "timeout" ? "TIMEOUT" : reason === "cancelled" ? "CANCELLED" : "OUTPUT_TOO_LARGE";
      settle(new SemgrepExecutionError(code, safeErrorMessage(code)));
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        terminate("output");
        return;
      }
      stdoutChunks.push(value);
    };
    child.stdout.on("data", onData);
    // Stderr is intentionally consumed and discarded. It can contain source
    // excerpts, command paths, or provider-adjacent data that must not be
    // copied into logs or durable execution metadata.
    child.stderr.on("data", () => undefined);
    child.once("error", () => {
      settle(new SemgrepExecutionError(options.errorCode, safeErrorMessage(options.errorCode)));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      if (timedOut) {
        settle(new SemgrepExecutionError("TIMEOUT", safeErrorMessage("TIMEOUT")));
        return;
      }
      if (cancelled) {
        settle(new SemgrepExecutionError("CANCELLED", safeErrorMessage("CANCELLED")));
        return;
      }
      settle(undefined, {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        exitCode,
      });
    });

    timeoutHandle = setTimeout(() => terminate("timeout"), options.timeoutMs);
    if (options.signal) {
      abortHandler = () => terminate("cancelled");
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

async function resolveSemgrepVersion(
  executable: string,
  options: Required<Pick<SemgrepRunnerOptions, "timeoutMs" | "maxOutputBytes">> & {
    cwd?: string;
    signal?: AbortSignal;
    spawnProcess: SpawnProcess;
  },
): Promise<string> {
  const result = await captureProcess(executable, ["--version"], {
    ...options,
    errorCode: "VERSION_FAILED",
  });
  if (result.exitCode !== 0) {
    throw new SemgrepExecutionError("VERSION_FAILED", safeErrorMessage("VERSION_FAILED"), result.exitCode);
  }
  const match = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u.exec(result.stdout);
  if (!match) throw new SemgrepExecutionError("VERSION_FAILED", safeErrorMessage("VERSION_FAILED"));
  return match[0];
}

function asSafeLine(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  return value;
}

function asSafeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const normalized = value.replace(/[\t\r\n ]+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  return normalized;
}

function asCategory(value: unknown): string {
  if (typeof value !== "string") {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const category = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(category)) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  return category;
}

function asSeverity(value: unknown): ReviewSeverity {
  if (value === "Critical" || value === "High" || value === "Medium" || value === "Low") {
    return value;
  }
  throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
}

function metadataValue(metadata: Record<string, unknown>, key: string): unknown {
  const nested = metadata.sentirev;
  if (nested && typeof nested === "object" && key in nested) {
    return (nested as Record<string, unknown>)[key];
  }
  return metadata[key];
}

function chunkForResult(
  resultPath: string,
  chunksByTemporaryName: ReadonlyMap<string, DiffChunk>,
): DiffChunk {
  const normalized = resultPath.replaceAll("\\", "/");
  const chunk = chunksByTemporaryName.get(normalized) ?? chunksByTemporaryName.get(basename(normalized));
  if (!chunk) throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  return chunk;
}

function buildSnippet(chunk: DiffChunk, startIndex: number, endIndex: number): string {
  const first = Math.max(0, startIndex - 2);
  const last = Math.min(chunk.lines.length - 1, endIndex + 2);
  const candidates = chunk.lines.slice(first, last + 1).map((line) => line.content);
  if (candidates.length > 12) candidates.splice(12);
  while (candidates.length > 0) {
    const snippet = candidates.join("\n");
    if (snippet.length > 0 && Buffer.byteLength(snippet, "utf8") <= 2_000) return snippet;
    if (candidates.length <= endIndex - startIndex + 1) break;
    candidates.shift();
    if (candidates.length > endIndex - startIndex + 1) candidates.pop();
  }
  throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
}

function normalizeResult(
  raw: SemgrepResult,
  chunksByTemporaryName: ReadonlyMap<string, DiffChunk>,
  engineIdentifier: string,
): ReviewFinding {
  if (
    typeof raw.path !== "string" ||
    typeof raw.check_id !== "string" ||
    !raw.extra ||
    typeof raw.extra !== "object" ||
    !raw.start ||
    !raw.end
  ) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const chunk = chunkForResult(raw.path, chunksByTemporaryName);
  const start = asSafeLine(raw.start.line);
  const end = asSafeLine(raw.end.line);
  if (end < start || start > chunk.lines.length || end > chunk.lines.length) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const startIndex = start - 1;
  const endIndex = end - 1;
  const citedLines = chunk.lines.slice(startIndex, endIndex + 1);
  const changedCitedLines = citedLines.filter((line) => line.kind === "added");
  if (changedCitedLines.length === 0) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const metadata = raw.extra.metadata;
  if (!metadata || typeof metadata !== "object") {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const metadataRecord = metadata as Record<string, unknown>;
  const severity = asSeverity(metadataValue(metadataRecord, "severity"));
  const category = asCategory(metadataValue(metadataRecord, "category"));
  const summary = asSafeText(raw.extra.message, 160);
  const reasoningValue = metadataValue(metadataRecord, "reasoning") ?? raw.extra.message;
  const reasoning = asSafeText(reasoningValue, 2_000);
  const startLine = changedCitedLines[0].newLineNumber;
  const endLine = changedCitedLines[changedCitedLines.length - 1].newLineNumber;
  const snippet = buildSnippet(chunk, startIndex, endIndex);
  try {
    return parseReviewFinding({
      filePath: chunk.filePath,
      startLine,
      endLine,
      severity,
      category,
      summary,
      reasoning,
      snippet,
      provenance: [{
        engineKind: "STATIC",
        engineIdentifier,
        staticRuleId: raw.check_id,
      }],
    });
  } catch {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
}

function assertChunkBounds(chunks: readonly DiffChunk[]): void {
  for (const chunk of chunks) {
    if (
      !isRepositoryRelativePath(chunk.filePath) ||
      !chunk.id ||
      !Array.isArray(chunk.lines) ||
      chunk.lines.length === 0 ||
      chunk.lines.length > MAX_PROVIDER_CHUNK_LINES ||
      Buffer.byteLength(`${chunk.text}\n`, "utf8") > MAX_PROVIDER_CHUNK_BYTES ||
      chunk.changedLineCount < 1 ||
      chunk.changedLineNumbers.length !== chunk.changedLineCount ||
      chunk.changedLineCount > chunk.lines.length
    ) {
      throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
    }
    const sourceExtension = extname(chunk.filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS[chunk.language].includes(sourceExtension)) {
      throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
    }
    const actualChanged = chunk.lines.filter((line) => line.kind === "added").map((line) => line.newLineNumber);
    if (actualChanged.join(",") !== chunk.changedLineNumbers.join(",")) {
      throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
    }
  }
}

function semgrepConfigDigest(configText: string): string {
  return createHash("sha256").update(configText, "utf8").digest("hex");
}

export async function runSemgrep(
  chunks: readonly DiffChunk[],
  options: SemgrepRunnerOptions = {},
): Promise<StaticAnalysisResult> {
  assertChunkBounds(chunks);
  const started = performance.now();
  const executable = options.executable ?? "semgrep";
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEMGREP_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_SEMGREP_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_SEMGREP_TIMEOUT_MS) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const processOptions = {
    timeoutMs,
    maxOutputBytes,
    cwd: options.cwd,
    signal: options.signal,
    spawnProcess,
  };
  const semgrepVersion = options.semgrepVersion ?? await resolveSemgrepVersion(executable, processOptions);
  const engineIdentifier = `semgrep@${semgrepVersion}`;
  if (chunks.length === 0) {
    return {
      engineKind: "STATIC",
      engineIdentifier,
      semgrepVersion,
      status: "COMPLETED",
      findings: [],
      durationMs: Math.round(performance.now() - started),
      findingCount: 0,
    };
  }

  const configuredPath = resolve(options.configPath ?? SENTIREV_SEMGREP_CONFIG);
  if (!configuredPath.endsWith(".yml") && !configuredPath.endsWith(".yaml")) {
    throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
  }
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(join(resolve(tmpdir()), "sentirev-semgrep-"));
    const chunksByTemporaryName = new Map<string, DiffChunk>();
    for (const [index, chunk] of chunks.entries()) {
      const fileName = `chunk-${String(index + 1).padStart(6, "0")}${temporaryExtensionForChunk(chunk)}`;
      const filePath = resolve(join(temporaryDirectory, fileName));
      await writeFile(filePath, `${chunk.text}\n`, { encoding: "utf8", flag: "wx" });
      chunksByTemporaryName.set(fileName, chunk);
      chunksByTemporaryName.set(filePath.replaceAll("\\", "/"), chunk);
    }

    const result = await captureProcess(
      executable,
      ["--config", configuredPath, "--json", "--no-git-ignore", "--metrics=off", "--quiet", temporaryDirectory],
      { ...processOptions, errorCode: "SPAWN_FAILED" },
    );
    let parsed: SemgrepJson;
    try {
      parsed = JSON.parse(result.stdout) as SemgrepJson;
    } catch {
      if (result.exitCode !== 0) {
        throw new SemgrepExecutionError("NONZERO_EXIT", safeErrorMessage("NONZERO_EXIT"), result.exitCode);
      }
      throw new SemgrepExecutionError("INVALID_JSON", safeErrorMessage("INVALID_JSON"));
    }
    const hasResultArray = Array.isArray(parsed.results);
    const hasSemgrepErrors =
      parsed.errors !== undefined &&
      (!Array.isArray(parsed.errors) || parsed.errors.length > 0);
    // Semgrep uses exit code 1 for a finding-bearing scan in some CLI
    // versions. Accept that documented result only after JSON and error
    // validation; all other nonzero exits remain execution failures.
    if (result.exitCode !== 0 && !(result.exitCode === 1 && hasResultArray && !hasSemgrepErrors)) {
      throw new SemgrepExecutionError("NONZERO_EXIT", safeErrorMessage("NONZERO_EXIT"), result.exitCode);
    }
    if (!hasResultArray) {
      throw new SemgrepExecutionError("INVALID_RESULT", safeErrorMessage("INVALID_RESULT"));
    }
    const resultEntries = parsed.results as unknown[];
    const findings = resultEntries.map((raw) => normalizeResult(
      raw as SemgrepResult,
      chunksByTemporaryName,
      engineIdentifier,
    ));
    return {
      engineKind: "STATIC",
      engineIdentifier,
      semgrepVersion,
      status: "COMPLETED",
      findings,
      durationMs: Math.round(performance.now() - started),
      findingCount: findings.length,
    };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export const runStaticAnalysis = runSemgrep;

export async function getSemgrepConfigDigest(configPath = SENTIREV_SEMGREP_CONFIG): Promise<string> {
  const text = await readFile(resolve(configPath), "utf8");
  return semgrepConfigDigest(text);
}
