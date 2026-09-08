import { afterEach, describe, expect, it, vi } from "vitest";

import invalidFixture from "../../fixtures/review/provider-invalid.json";
import successFixture from "../../fixtures/review/provider-success.json";
import zeroFixture from "../../fixtures/review/provider-zero.json";
import {
  batchProviderChunks,
  createProviderAdapter,
  MAX_PROVIDER_BATCH_BYTES,
  MAX_PROVIDER_BATCH_SELECTED_LINES,
  type ProviderReviewInput,
} from "@/lib/review/providers/adapters";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  OPENROUTER_BASE_URL,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  OpenRouterError,
  PRIMARY_MODEL,
  PRIMARY_REASONING_ENABLED,
  PROVIDER_MODELS,
  requestOpenRouter,
} from "@/lib/review/providers/openrouter";

const syntheticKey = "synthetic-test-key";

const reviewInput: ProviderReviewInput = {
  chunks: [
    {
      chunkId: "chunk-1",
      filePath: "src/auth/check.ts",
      content: 'if (!user.isAdmin) throw new Error("forbidden");',
      lines: [
        {
          line: 7,
          text: 'if (!user.isAdmin) throw new Error("forbidden");',
          changed: true,
        },
      ],
      changedLines: [7],
    },
  ],
};

function responseFrom(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchMockFor(...responses: Response[]) {
  return vi.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("synthetic response queue exhausted");
    return response;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouter boundary", () => {
  it("uses the exact singular model route, enabled reasoning, and safe errors", async () => {
    const fetchMock = fetchMockFor(responseFrom(zeroFixture));
    const result = await requestOpenRouter({
      apiKey: syntheticKey,
      model: PRIMARY_MODEL,
      messages: [{ role: "user", content: "synthetic bounded hunk" }],
      fetchImpl: fetchMock,
    });

    expect(PROVIDER_MODELS).toEqual([PRIMARY_MODEL]);
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(result.model).toBe(PRIMARY_MODEL);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${syntheticKey}`,
    );
    const body = JSON.parse(String(request.body)) as {
      model?: string;
      reasoning?: { effort?: string; exclude?: boolean };
      response_format?: { type?: string };
    };
    expect(body.model).toBe(PRIMARY_MODEL);
    expect(body.reasoning).toEqual({ enabled: PRIMARY_REASONING_ENABLED, exclude: true });
    expect(body.response_format).toBeUndefined();
    expect(new OpenRouterError("provider_error", false).message).not.toContain(syntheticKey);
  });

  it("rejects an unapproved model and a missing owner key before fetch", async () => {
    const fetchMock = vi.fn();

    await expect(
      requestOpenRouter({
        apiKey: syntheticKey,
        model: "openrouter/free" as never,
        messages: [{ role: "user", content: "synthetic bounded hunk" }],
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "invalid_model" });
    await expect(
      requestOpenRouter({
        apiKey: "",
        model: PRIMARY_MODEL,
        messages: [{ role: "user", content: "synthetic bounded hunk" }],
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "missing_key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a hung provider at the explicit deadline", async () => {
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
    );

    await expect(
      requestOpenRouter({
        apiKey: syntheticKey,
        model: PRIMARY_MODEL,
        messages: [{ role: "user", content: "synthetic bounded hunk" }],
        timeoutMs: 5,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("honors a parent abort without exposing the owner key", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    const result = requestOpenRouter({
      apiKey: syntheticKey,
      model: PRIMARY_MODEL,
      messages: [{ role: "user", content: "synthetic bounded hunk" }],
      signal: controller.signal,
      fetchImpl: fetchMock,
    });

    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that exceeds the bounded response limit", async () => {
    const oversized = responseFrom({
      choices: [{ message: { content: "x".repeat(MAX_PROVIDER_RESPONSE_BYTES) } }],
    });

    await expect(
      requestOpenRouter({
        apiKey: syntheticKey,
        model: PRIMARY_MODEL,
        messages: [{ role: "user", content: "synthetic bounded hunk" }],
        fetchImpl: fetchMockFor(oversized),
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
});

describe("single-model provider adapter", () => {
  it("returns a bounded, cited finding with fixed-model provenance", async () => {
    const fetchMock = fetchMockFor(responseFrom(successFixture));
    const adapter = createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    });

    const result = await adapter.review(reviewInput, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe("success");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      filePath: reviewInput.chunks[0]?.filePath,
      startLine: 7,
      endLine: 7,
      severity: "High",
      provenance: [{ engineKind: "AI", engineIdentifier: PRIMARY_MODEL }],
    });
    expect(result.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.engineResult?.engineIdentifier).toBe(PRIMARY_MODEL);
  });

  it("accepts a valid zero-findings response", async () => {
    const fetchMock = fetchMockFor(responseFrom(zeroFixture));
    const result = await createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    }).review(reviewInput, { apiKey: syntheticKey, fetchImpl: fetchMock });

    expect(result).toMatchObject({
      status: "success",
      model: PRIMARY_MODEL,
      findings: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe or unknown chunk citations locally", async () => {
    const fetchMock = fetchMockFor(
      responseFrom({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    chunkId: "unknown",
                    severity: "High",
                    category: "authorization-bypass",
                    summary: "Unknown chunk.",
                    cited_lines: [7],
                    reasoning: "The chunk ID is not part of the request.",
                    snippet: "if (!user.isAdmin) throw new Error(\"forbidden\");",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
    const result = await createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    }).review(reviewInput, { apiKey: syntheticKey, fetchImpl: fetchMock });

    expect(result.status).toBe("failure");
    expect(result.findings).toEqual([]);
    expect(result.failure).toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("admits one request for a batch and never exposes quota details", async () => {
    const fetchMock = fetchMockFor(responseFrom(zeroFixture));
    const acquirePermit = vi.fn(async () => ({ granted: true as const, permitId: "opaque" }));
    const result = await createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      quota: { acquirePermit },
      fetchImpl: fetchMock,
    }).review(reviewInput, {
      apiKey: syntheticKey,
      quota: { acquirePermit },
      fetchImpl: fetchMock,
    });

    expect(result.status).toBe("success");
    expect(acquirePermit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/repository|diff|secret|api[_-]?key/iu);
  });

  it("does not call OpenRouter when the local daily quota is exhausted", async () => {
    const fetchMock = vi.fn();
    const result = await createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      quota: {
        acquirePermit: async () => ({ granted: false as const, reason: "daily_quota_exhausted" as const }),
      },
      fetchImpl: fetchMock,
    }).review(reviewInput, { apiKey: syntheticKey, fetchImpl: fetchMock });

    expect(result).toMatchObject({
      status: "failure",
      failure: { code: "daily_quota_exhausted", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a provider rate limit or call another model", async () => {
    const fetchMock = fetchMockFor(
      responseFrom({ error: { message: "synthetic rate limit" } }, 429),
    );
    const result = await createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    }).review(reviewInput, { apiKey: syntheticKey, fetchImpl: fetchMock });

    expect(result).toMatchObject({
      status: "failure",
      model: PRIMARY_MODEL,
      failure: { code: "rate_limited", retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a retryable provider failure without retrying in the same run", async () => {
    const fetchMock = fetchMockFor(
      responseFrom({ error: { message: "synthetic outage" } }, 503),
    );
    const result = await createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    }).review(reviewInput, { apiKey: syntheticKey, fetchImpl: fetchMock });

    expect(result).toMatchObject({
      status: "failure",
      model: PRIMARY_MODEL,
      failure: { code: "provider_error", retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("packs bounded chunks deterministically within request limits", () => {
    const chunks = Array.from({ length: 5 }, (_, index) => ({
      ...reviewInput.chunks[0]!,
      chunkId: `chunk-${index + 1}`,
      changedLines: [index + 1],
      lines: [{ line: index + 1, text: "const safe = true;", changed: true }],
      content: "const safe = true;",
    }));
    const batches = batchProviderChunks(chunks);

    expect(batches.flatMap((batch) => batch.chunks).map((chunk) => chunk.chunkId)).toEqual(
      chunks.map((chunk) => chunk.chunkId),
    );
    expect(batches.every((batch) =>
      batch.chunks.reduce((total, chunk) => total + chunk.changedLines.length, 0) <=
        MAX_PROVIDER_BATCH_SELECTED_LINES,
    )).toBe(true);
    expect(batches.every((batch) => JSON.stringify(batch).length < MAX_PROVIDER_BATCH_BYTES)).toBe(true);
  });

  it("does not call a provider for an unbounded or unsupported chunk", async () => {
    const fetchMock = vi.fn();
    const adapter = createProviderAdapter(PRIMARY_MODEL, {
      apiKey: syntheticKey,
      fetchImpl: fetchMock,
    });

    const result = await adapter.review(
      {
        chunks: [{
          ...reviewInput.chunks[0]!,
          filePath: "README.md",
        }],
      },
      { apiKey: syntheticKey, fetchImpl: fetchMock },
    );

    expect(result).toMatchObject({
      status: "failure",
      failure: { code: "invalid_input", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
