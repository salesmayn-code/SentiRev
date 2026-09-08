import {
  isRepositoryRelativePath,
  MAX_REASONING_LENGTH,
  MAX_SNIPPET_BYTES,
  MAX_SNIPPET_LINES,
  MAX_SUMMARY_LENGTH,
  parseReviewFinding,
  REVIEW_SEVERITIES,
  type EngineResult,
  type ReviewFinding,
} from "@/lib/review/schema";

import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  OpenRouterError,
  PRIMARY_MODEL,
  PROVIDER_MODELS,
  requestOpenRouter,
  type OpenRouterFailureCode,
  type ProviderModelId,
} from "./openrouter";
import type { OpenRouterQuota } from "../quota";

export { PRIMARY_MODEL, PROVIDER_MODELS } from "./openrouter";
export type { ProviderModelId } from "./openrouter";

export const MAX_PROVIDER_CHUNK_LINES = 200;
export const MAX_PROVIDER_CHUNK_BYTES = 24 * 1024;
export const MAX_PROVIDER_BATCH_SELECTED_LINES = 800;
export const MAX_PROVIDER_BATCH_BYTES = 96 * 1024;
const MAX_PROVIDER_FINDINGS = 200;

export type ProviderChunkLine = {
  line: number;
  text: string;
  changed: boolean;
};

/**
 * A provider chunk is already bounded by the unified-diff parser. The model
 * receives only this representation; it never receives a repository path
 * outside the validated chunk or a full source file.
 */
export type ProviderReviewChunk = {
  chunkId: string;
  filePath: string;
  content: string;
  lines: readonly ProviderChunkLine[];
  changedLines: readonly number[];
};

export type ProviderReviewBatch = {
  chunks: readonly ProviderReviewChunk[];
};

export type ProviderReviewInput = ProviderReviewBatch;

export type ProviderReviewOptions = {
  apiKey: string;
  quota?: OpenRouterQuota;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type ProviderFailureCode =
  | OpenRouterFailureCode
  | "invalid_input"
  | "quota_unavailable"
  | "daily_quota_exhausted";

export type ProviderFailure = {
  code: ProviderFailureCode;
  retryable: boolean;
};

export type ProviderReviewResult = {
  model: ProviderModelId;
  status: "success" | "failure";
  findings: ReviewFinding[];
  durationMs: number;
  failure?: ProviderFailure;
  engineResult?: EngineResult;
};

export type ProviderAdapter = {
  readonly model: ProviderModelId;
  review(
    input: ProviderReviewInput,
    options: ProviderReviewOptions,
  ): Promise<ProviderReviewResult>;
};

const PROVIDER_SYSTEM_PROMPT =
  "You are SentiRev's bounded pull-request review engine. Review only the supplied changed hunks. Return exactly one JSON object with a findings array and no markdown or prose. Each finding object must contain exactly these keys: chunkId, severity, category, summary, cited_lines, reasoning, snippet. chunkId must exactly match one supplied chunk ID. cited_lines must be a contiguous list of changed new-side line numbers from that chunk; never invent file paths or line numbers. Use severity Critical, High, Medium, or Low; a lowercase kebab-case category; a direct one-line summary; bounded reasoning; and a short code snippet containing the cited line. Return {\"findings\":[]} when no issue is supported by the supplied hunks.";

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validChunkId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function lineText(input: ProviderReviewChunk, lineNumber: number): string | undefined {
  return input.lines.find((line) => line.line === lineNumber)?.text;
}

function formatPromptLines(input: ProviderReviewChunk): string {
  return input.lines
    .map(
      (line) =>
        `${line.line.toString().padStart(8, " ")} ${line.changed ? "+" : " "} | ${line.text}`,
    )
    .join("\n");
}

function formatPromptChunk(input: ProviderReviewChunk): string {
  return `Chunk ID: ${input.chunkId}\nRepository-relative file: ${input.filePath}\nChanged hunk lines (a + marker means a changed new-side line):\n${formatPromptLines(input)}`;
}

function formatPrompt(input: ProviderReviewInput): string {
  return input.chunks.map(formatPromptChunk).join("\n\n");
}

function promptByteLength(input: ProviderReviewInput): number {
  return byteLength(PROVIDER_SYSTEM_PROMPT) + byteLength(formatPrompt(input));
}

function invalidChunk(input: ProviderReviewChunk): ProviderFailure | undefined {
  if (!validChunkId(input.chunkId)) {
    return { code: "invalid_input", retryable: false };
  }
  if (!isRepositoryRelativePath(input.filePath)) {
    return { code: "invalid_input", retryable: false };
  }
  if (!/\.(?:js|jsx|ts|tsx|py)$/iu.test(input.filePath)) {
    return { code: "invalid_input", retryable: false };
  }
  if (
    input.content.length === 0 ||
    byteLength(input.content) > MAX_PROVIDER_CHUNK_BYTES ||
    input.lines.length === 0 ||
    input.lines.length > MAX_PROVIDER_CHUNK_LINES
  ) {
    return { code: "invalid_input", retryable: false };
  }

  const lineNumbers = new Set<number>();
  for (const line of input.lines) {
    if (
      !Number.isSafeInteger(line.line) ||
      line.line <= 0 ||
      line.line > 10_000_000 ||
      typeof line.text !== "string" ||
      typeof line.changed !== "boolean" ||
      line.text.includes("\0") ||
      lineNumbers.has(line.line)
    ) {
      return { code: "invalid_input", retryable: false };
    }
    lineNumbers.add(line.line);
  }

  const changedLines = new Set(input.changedLines);
  if (
    changedLines.size === 0 ||
    changedLines.size !== input.changedLines.length ||
    [...changedLines].some(
      (line) => !Number.isSafeInteger(line) || line <= 0 || line > 10_000_000,
    ) ||
    [...changedLines].some(
      (line) =>
        !lineNumbers.has(line) ||
        !input.lines.some((item) => item.line === line && item.changed),
    )
  ) {
    return { code: "invalid_input", retryable: false };
  }

  return undefined;
}

function invalidInput(input: ProviderReviewInput): ProviderFailure | undefined {
  if (!input || !Array.isArray(input.chunks) || input.chunks.length === 0) {
    return { code: "invalid_input", retryable: false };
  }

  const chunkIds = new Set<string>();
  let selectedLines = 0;
  for (const chunk of input.chunks) {
    if (chunkIds.has(chunk.chunkId)) {
      return { code: "invalid_input", retryable: false };
    }
    chunkIds.add(chunk.chunkId);

    const chunkFailure = invalidChunk(chunk);
    if (chunkFailure) return chunkFailure;

    selectedLines += chunk.changedLines.length;
    if (selectedLines > MAX_PROVIDER_BATCH_SELECTED_LINES) {
      return { code: "invalid_input", retryable: false };
    }
  }

  if (promptByteLength(input) > MAX_PROVIDER_BATCH_BYTES) {
    return { code: "invalid_input", retryable: false };
  }

  return undefined;
}

/**
 * Pack validated chunks without crossing either the selected-line or UTF-8
 * prompt bound. The function is deterministic and never combines duplicate
 * chunk IDs. A caller still gets one request for a chunk that is itself valid.
 */
export function batchProviderChunks(
  chunks: readonly ProviderReviewChunk[],
): ProviderReviewBatch[] {
  const batches: ProviderReviewBatch[] = [];
  let current: ProviderReviewChunk[] = [];
  let selectedLines = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({ chunks: current });
    current = [];
    selectedLines = 0;
  };

  for (const chunk of chunks) {
    const candidate = [...current, chunk];
    const candidateInput = { chunks: candidate };
    const exceedsLines =
      selectedLines + chunk.changedLines.length > MAX_PROVIDER_BATCH_SELECTED_LINES;
    const exceedsBytes = promptByteLength(candidateInput) > MAX_PROVIDER_BATCH_BYTES;
    if (current.length > 0 && (exceedsLines || exceedsBytes)) flush();

    current.push(chunk);
    selectedLines += chunk.changedLines.length;
    if (
      selectedLines > MAX_PROVIDER_BATCH_SELECTED_LINES ||
      promptByteLength({ chunks: current }) > MAX_PROVIDER_BATCH_BYTES
    ) {
      throw new OpenRouterError("invalid_response", false);
    }
  }
  flush();
  return batches;
}

function providerMessages(input: ProviderReviewInput) {
  return [
    { role: "system" as const, content: PROVIDER_SYSTEM_PROMPT },
    { role: "user" as const, content: formatPrompt(input) },
  ];
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const firstNewline = trimmed.indexOf("\n");
  const lastFence = trimmed.lastIndexOf("```");
  if (firstNewline < 0 || lastFence <= firstNewline) return trimmed;
  return trimmed.slice(firstNewline + 1, lastFence).trim();
}

function parseModelPayload(content: string): unknown {
  try {
    return JSON.parse(stripJsonFence(content)) as unknown;
  } catch {
    throw new OpenRouterError("invalid_response", false);
  }
}

function validateProviderFinding(
  value: unknown,
  input: ProviderReviewChunk,
  model: ProviderModelId,
  apiKey: string,
): ReviewFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenRouterError("invalid_response", false);
  }

  const candidate = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "filePath",
    "startLine",
    "endLine",
    "severity",
    "category",
    "summary",
    "reasoning",
    "snippet",
  ]);
  if (
    Object.keys(candidate).some((key) => !expectedKeys.has(key)) ||
    Object.keys(candidate).length !== expectedKeys.size
  ) {
    throw new OpenRouterError("invalid_response", false);
  }

  const filePath = candidate.filePath;
  const startLine = candidate.startLine;
  const endLine = candidate.endLine;
  const severity = candidate.severity;
  const category = candidate.category;
  const summary = candidate.summary;
  const reasoning = candidate.reasoning;
  const snippet = candidate.snippet;

  if (
    typeof filePath !== "string" ||
    filePath !== input.filePath ||
    !isRepositoryRelativePath(filePath) ||
    typeof startLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    typeof endLine !== "number" ||
    !Number.isSafeInteger(endLine) ||
    endLine < startLine ||
    typeof severity !== "string" ||
    !REVIEW_SEVERITIES.includes(severity as (typeof REVIEW_SEVERITIES)[number]) ||
    typeof category !== "string" ||
    typeof summary !== "string" ||
    typeof reasoning !== "string" ||
    typeof snippet !== "string"
  ) {
    throw new OpenRouterError("invalid_response", false);
  }

  const changedLines = new Set(input.changedLines);
  const citedSpan = endLine - startLine + 1;
  const citedChangedCount = [...changedLines].filter(
    (line) => line >= startLine && line <= endLine,
  ).length;
  if (
    startLine <= 0 ||
    endLine > 10_000_000 ||
    citedSpan < 1 ||
    citedSpan > MAX_PROVIDER_CHUNK_LINES ||
    citedChangedCount !== citedSpan
  ) {
    throw new OpenRouterError("invalid_response", false);
  }

  if (
    /[\r\n]/u.test(summary) ||
    summary.trim().length === 0 ||
    summary.trim().length > MAX_SUMMARY_LENGTH ||
    reasoning.trim().length === 0 ||
    reasoning.trim().length > MAX_REASONING_LENGTH ||
    snippet.length === 0 ||
    snippet.split(/\r?\n/u).length > MAX_SNIPPET_LINES ||
    byteLength(snippet) > MAX_SNIPPET_BYTES ||
    (apiKey.length > 0 &&
      (summary.includes(apiKey) || reasoning.includes(apiKey) || snippet.includes(apiKey)))
  ) {
    throw new OpenRouterError("invalid_response", false);
  }

  const citedText = lineText(input, startLine) ?? lineText(input, endLine);
  if (!citedText || citedText.trim().length === 0 || !snippet.includes(citedText.trim())) {
    throw new OpenRouterError("invalid_response", false);
  }

  try {
    return parseReviewFinding({
      filePath,
      startLine,
      endLine,
      severity,
      category,
      summary,
      reasoning,
      snippet,
      provenance: [{ engineKind: "AI", engineIdentifier: model }],
    });
  } catch {
    throw new OpenRouterError("invalid_response", false);
  }
}

function normalizeProviderSummary(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/[\t\r\n ]+/gu, " ").trim();
}

function normalizeProviderFinding(
  value: unknown,
  input: ProviderReviewInput,
  model: ProviderModelId,
  apiKey: string,
): ReviewFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenRouterError("invalid_response", false);
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const providerKeys = new Set([
    "chunkId",
    "severity",
    "category",
    "summary",
    "cited_lines",
    "reasoning",
    "snippet",
  ]);
  if (keys.length !== providerKeys.size || !keys.every((key) => providerKeys.has(key))) {
    throw new OpenRouterError("invalid_response", false);
  }

  const chunkId = candidate.chunkId;
  const chunk =
    typeof chunkId === "string"
      ? input.chunks.find((item) => item.chunkId === chunkId)
      : undefined;
  if (!chunk) {
    throw new OpenRouterError("invalid_response", false);
  }

  const citedLines = candidate.cited_lines;
  if (
    !Array.isArray(citedLines) ||
    citedLines.length === 0 ||
    citedLines.length > MAX_PROVIDER_CHUNK_LINES ||
    citedLines.some((line) => !Number.isSafeInteger(line) || (line as number) <= 0)
  ) {
    throw new OpenRouterError("invalid_response", false);
  }

  const normalizedLines = [...(citedLines as number[])].sort((a, b) => a - b);
  if (
    new Set(normalizedLines).size !== normalizedLines.length ||
    normalizedLines.some(
      (line, index) => index > 0 && line !== normalizedLines[index - 1] + 1,
    )
  ) {
    throw new OpenRouterError("invalid_response", false);
  }

  return validateProviderFinding(
    {
      filePath: chunk.filePath,
      startLine: normalizedLines[0],
      endLine: normalizedLines[normalizedLines.length - 1],
      severity: candidate.severity,
      category: candidate.category,
      summary: normalizeProviderSummary(candidate.summary),
      reasoning: candidate.reasoning,
      snippet: candidate.snippet,
    },
    chunk,
    model,
    apiKey,
  );
}

function parseProviderFindings(
  content: string,
  input: ProviderReviewInput,
  model: ProviderModelId,
  apiKey: string,
): ReviewFinding[] {
  const payload = parseModelPayload(content);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new OpenRouterError("invalid_response", false);
  }
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, "findings") ||
    !Array.isArray(record.findings) ||
    record.findings.length > MAX_PROVIDER_FINDINGS
  ) {
    throw new OpenRouterError("invalid_response", false);
  }
  return record.findings.map((finding) =>
    normalizeProviderFinding(finding, input, model, apiKey),
  );
}

function failureFrom(error: unknown): ProviderFailure {
  if (error instanceof OpenRouterError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "network_error", retryable: true };
}

function engineResult(model: ProviderModelId, findings: ReviewFinding[]): EngineResult {
  return {
    engineKind: "AI",
    engineIdentifier: model,
    findings,
  };
}

function quotaFailure(reason: "rate_limited" | "daily_quota_exhausted"): ProviderFailure {
  return {
    code: reason === "daily_quota_exhausted" ? "daily_quota_exhausted" : "rate_limited",
    retryable: false,
  };
}

export function createProviderAdapter(
  model: ProviderModelId,
  defaults: ProviderReviewOptions,
): ProviderAdapter {
  if (model !== PRIMARY_MODEL) {
    throw new OpenRouterError("invalid_model", false);
  }

  return {
    model,
    async review(input, options) {
      const startedAt = Date.now();
      const requestOptions = { ...defaults, ...options };
      const inputFailure = invalidInput(input);
      if (inputFailure) {
        return {
          model,
          status: "failure",
          findings: [],
          durationMs: Date.now() - startedAt,
          failure: inputFailure,
        };
      }

      if (requestOptions.signal?.aborted) {
        return {
          model,
          status: "failure",
          findings: [],
          durationMs: Date.now() - startedAt,
          failure: { code: "cancelled", retryable: false },
        };
      }

      if (requestOptions.quota) {
        let permit;
        try {
          permit = await requestOptions.quota.acquirePermit();
        } catch {
          return {
            model,
            status: "failure",
            findings: [],
            durationMs: Date.now() - startedAt,
            failure: { code: "quota_unavailable", retryable: true },
          };
        }
        if (!permit.granted) return {
          model,
          status: "failure",
          findings: [],
          durationMs: Date.now() - startedAt,
          failure: quotaFailure(permit.reason),
        };
      }

      try {
        const response = await requestOpenRouter({
          apiKey: requestOptions.apiKey,
          model,
          messages: providerMessages(input),
          timeoutMs: requestOptions.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
          signal: requestOptions.signal,
          fetchImpl: requestOptions.fetchImpl,
        });
        const findings = parseProviderFindings(
          response.content,
          input,
          model,
          requestOptions.apiKey,
        );
        return {
          model,
          status: "success",
          findings,
          durationMs: Date.now() - startedAt,
          engineResult: engineResult(model, findings),
        };
      } catch (error) {
        return {
          model,
          status: "failure",
          findings: [],
          durationMs: Date.now() - startedAt,
          failure: failureFrom(error),
        };
      }
    },
  };
}
