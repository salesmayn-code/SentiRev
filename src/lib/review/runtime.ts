import { getOwnerOpenRouterApiKey } from "@/lib/env";
import { getRedisConnection } from "@/lib/queue/connection";
import { parseUnifiedDiff, type DiffChunk } from "@/lib/review/diff";
import type { EngineExecution } from "@/lib/review/outcomes";
import type { ReviewServiceDependencies } from "@/lib/review/service";
import {
  batchProviderChunks,
  createProviderAdapter,
  type ProviderReviewChunk,
  type ProviderReviewResult,
} from "@/lib/review/providers/adapters";
import { createOpenRouterQuota, type OpenRouterQuota } from "@/lib/review/quota";
import { PRIMARY_MODEL } from "@/lib/review/providers/openrouter";
import { runSemgrep } from "@/lib/review/static";

function providerInput(chunk: DiffChunk): ProviderReviewChunk {
  return {
    chunkId: chunk.id,
    filePath: chunk.filePath,
    content: chunk.text,
    lines: chunk.lines.map((line) => ({
      line: line.newLineNumber,
      text: line.content,
      changed: line.kind === "added",
    })),
    changedLines: [...chunk.changedLineNumbers],
  };
}

function executionCode(result: ProviderReviewResult): EngineExecution["code"] {
  if (result.status === "success") return "SUCCEEDED";
  if (result.failure?.code === "timeout" || result.failure?.code === "cancelled") {
    return "TIMED_OUT";
  }
  if (result.failure?.code === "invalid_response") return "INVALID";
  return "FAILED";
}

function aggregateProviderExecution(
  attempts: ProviderReviewResult[],
): EngineExecution {
  const successful = attempts.filter((attempt) => attempt.status === "success");
  const allSuccessful = attempts.length > 0 && successful.length === attempts.length;
  const representativeFailure = attempts.find((attempt) => attempt.status === "failure");
  return {
    path: "AI",
    engineKind: "AI",
    engineIdentifier: PRIMARY_MODEL,
    code: allSuccessful
      ? "SUCCEEDED"
      : successful.length > 0
        ? "PARTIAL"
        : representativeFailure
          ? executionCode(representativeFailure)
          : "FAILED",
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    findings: successful.flatMap((attempt) => attempt.findings),
  };
}

export type ReviewRuntimeOptions = {
  quota?: OpenRouterQuota;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createReviewRuntime(
  apiKey: string,
  options: ReviewRuntimeOptions = {},
): ReviewServiceDependencies {
  return {
    parseDiff: (rawDiff) =>
      parseUnifiedDiff(rawDiff).chunks.map((chunk) => ({
        filePath: chunk.filePath,
        text: chunk.text,
        changedNewLines: [...chunk.changedLineNumbers],
        source: chunk,
      })),
    runStatic: async (serviceChunks, signal) => {
      const chunks = serviceChunks.map((chunk) => {
        if (!chunk.source) throw new Error("Missing bounded parser chunk");
        return chunk.source;
      });
      const result = await runSemgrep(chunks, { signal });
      return {
        path: "STATIC",
        engineKind: "STATIC",
        engineIdentifier: result.engineIdentifier,
        code: "SUCCEEDED",
        durationMs: result.durationMs,
        findings: [...result.findings],
      };
    },
    runAi: async (serviceChunks, signal) => {
      const chunks = serviceChunks.map((chunk) => {
        if (!chunk.source) throw new Error("Missing bounded parser chunk");
        return chunk.source;
      });
      if (chunks.length === 0) {
        return [{
          path: "AI",
          engineKind: "AI",
          engineIdentifier: PRIMARY_MODEL,
          code: "SUCCEEDED",
          durationMs: 0,
          findings: [],
        }];
      }

      const providerChunks = chunks.map(providerInput);
      const batches = batchProviderChunks(providerChunks);
      const adapter = createProviderAdapter(PRIMARY_MODEL, {
        apiKey,
        quota: options.quota,
        signal,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      const attempts: ProviderReviewResult[] = [];
      for (const batch of batches) {
        attempts.push(
          await adapter.review(batch, {
            apiKey,
            quota: options.quota,
            signal,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
          }),
        );
      }
      return [aggregateProviderExecution(attempts)];
    },
  };
}

export function createOwnerManagedReviewRuntime(): ReviewServiceDependencies {
  const quota = createOpenRouterQuota(getRedisConnection());
  return createReviewRuntime(getOwnerOpenRouterApiKey(), { quota });
}
