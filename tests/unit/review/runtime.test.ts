import { describe, expect, it, vi } from "vitest";

import { createReviewRuntime } from "@/lib/review/runtime";
import type { DiffChunk } from "@/lib/review/diff";
import { PRIMARY_MODEL } from "@/lib/review/providers/openrouter";
import type { ReviewChunk } from "@/lib/review/service";

function sourceChunk(id: string, line: number): DiffChunk {
  return {
    id,
    filePath: "src/example.ts",
    language: "typescript",
    hunkIndex: 0,
    segmentIndex: line - 1,
    lines: [{ kind: "added", content: "const safe = true;", newLineNumber: line }],
    text: "const safe = true;",
    changedLineNumbers: [line],
    changedLineCount: 1,
    contextLineCount: 0,
    startLine: line,
    endLine: line,
    byteLength: Buffer.byteLength("const safe = true;\n", "utf8"),
  };
}

function serviceChunks(...ids: string[]): ReviewChunk[] {
  return ids.map((id, index) => {
    const source = sourceChunk(id, index + 1);
    return {
      filePath: source.filePath,
      text: source.text,
      changedNewLines: [...source.changedLineNumbers],
      source,
    };
  });
}

function zeroResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("review runtime OpenRouter batching", () => {
  it("accepts chunks produced by the real unified-diff parser", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => zeroResponse());
    const runtime = createReviewRuntime("synthetic-owner-key", { fetchImpl: fetchMock });
    const chunks = runtime.parseDiff([
      "diff --git a/src/review.ts b/src/review.ts",
      "--- a/src/review.ts",
      "+++ b/src/review.ts",
      "@@ -1,1 +1,2 @@",
      " const safe = true;",
      "+review(input);",
    ].join("\n"));

    const executions = await runtime.runAi(chunks, new AbortController().signal);

    expect(executions[0]).toMatchObject({ code: "SUCCEEDED", findings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).toMatch(/Chunk ID: chunk-[a-f0-9]{64}/u);
  });

  it("sends several bounded chunks in one fixed-model request", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => zeroResponse());
    const runtime = createReviewRuntime("synthetic-owner-key", { fetchImpl: fetchMock });
    const executions = await runtime.runAi(serviceChunks("chunk-1", "chunk-2"), new AbortController().signal);

    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      path: "AI",
      engineIdentifier: PRIMARY_MODEL,
      code: "SUCCEEDED",
      findings: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = String(request.body);
    expect(body).toContain("Chunk ID: chunk-1");
    expect(body).toContain("Chunk ID: chunk-2");
  });

  it("records a quota denial without making an external request", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => zeroResponse());
    const runtime = createReviewRuntime("synthetic-owner-key", {
      fetchImpl: fetchMock,
      quota: {
        acquirePermit: async () => ({
          granted: false as const,
          reason: "daily_quota_exhausted" as const,
        }),
      },
    });
    const executions = await runtime.runAi(serviceChunks("chunk-1"), new AbortController().signal);

    expect(executions[0]).toMatchObject({
      engineIdentifier: PRIMARY_MODEL,
      code: "FAILED",
      findings: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
