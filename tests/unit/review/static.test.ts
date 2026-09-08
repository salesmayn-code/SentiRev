import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseUnifiedDiff, type DiffChunk } from "../../../src/lib/review/diff";
import {
  getSemgrepConfigDigest,
  runSemgrep,
} from "../../../src/lib/review/static";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const chunksFromDiff = (source: string): DiffChunk[] => parseUnifiedDiff(source).chunks as DiffChunk[];

const javascriptChunks = chunksFromDiff([
  "diff --git a/src/review.js b/src/review.js",
  "--- a/src/review.js",
  "+++ b/src/review.js",
  "@@ -1,2 +1,4 @@",
  " export function handle(input) {",
  "+  eval(input);",
  "+  return sanitize(input);",
  " }",
].join("\n"));

function fakeSpawn(
  scanOutput: string | undefined,
  scanExitCode = 0,
  behavior: "normal" | "never" = "normal",
) {
  let scanDirectory: string | undefined;
  const spawnProcess = vi.fn((_: string, args: readonly string[], _options: unknown) => {
    const child = new FakeChild();
    const isVersion = args[0] === "--version";
    if (!isVersion) scanDirectory = args.at(-1);
    if (behavior === "normal") {
      setImmediate(() => {
        if (isVersion) child.stdout.end("semgrep 1.176.0\n");
        else if (scanOutput !== undefined) child.stdout.end(scanOutput);
        else child.stdout.end();
        child.stderr.end();
        child.emit("close", isVersion ? 0 : scanExitCode, null);
      });
    }
    return child as never;
  });
  return { spawnProcess, getScanDirectory: () => scanDirectory };
}

function validSemgrepResponse(path: string): string {
  return JSON.stringify({
    results: [{
      check_id: "sentirev.javascript.eval-input",
      path,
      start: { line: 2, col: 3 },
      end: { line: 2, col: 15 },
      extra: {
        message: "Untrusted data is passed to eval.",
        severity: "WARNING",
        metadata: {
          sentirev: {
            category: "code-execution",
            severity: "Critical",
            reasoning: "eval executes input as code.",
          },
        },
      },
    }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Semgrep static-analysis boundary", () => {
  it("uses an argument array, maps findings to changed new-side lines, and removes temporary chunks", async () => {
    const fake = fakeSpawn(validSemgrepResponse("chunk-000001.js"), 1);

    const result = await runSemgrep(javascriptChunks, {
      spawnProcess: fake.spawnProcess as never,
      cwd: process.cwd(),
    });

    expect(result.engineKind).toBe("STATIC");
    expect(result.engineIdentifier).toBe("semgrep@1.176.0");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].filePath).toBe("src/review.js");
    expect(result.findings[0].startLine).toBe(2);
    expect(result.findings[0].endLine).toBe(2);
    expect(result.findings[0].severity).toBe("Critical");
    expect(result.findings[0].provenance[0]).toEqual({
      engineKind: "STATIC",
      engineIdentifier: "semgrep@1.176.0",
      staticRuleId: "sentirev.javascript.eval-input",
    });
    expect(fake.spawnProcess).toHaveBeenCalledTimes(2);
    const scanCall = fake.spawnProcess.mock.calls[1];
    expect(scanCall[0]).toBe("semgrep");
    expect(scanCall[2]).toMatchObject({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    expect(scanCall[2]).not.toHaveProperty("shell", true);
    expect(fake.getScanDirectory()).toBeDefined();
    expect(existsSync(fake.getScanDirectory() ?? "")).toBe(false);
  });

  it("returns a valid zero-findings result without invoking a scan for no changed chunks", async () => {
    const result = await runSemgrep([], { semgrepVersion: "1.176.0" });

    expect(result.status).toBe("COMPLETED");
    expect(result.findings).toEqual([]);
    expect(result.findingCount).toBe(0);
  });

  it("rejects an unknown Semgrep path, invalid severity, and malformed JSON", async () => {
    const unknownPath = fakeSpawn(JSON.stringify({ results: [{
      check_id: "sentirev.javascript.eval-input",
      path: "chunk-999999.js",
      start: { line: 2 },
      end: { line: 2 },
      extra: { message: "Finding", metadata: { sentirev: { category: "code-execution", severity: "Critical" } } },
    }] }));
    await expect(runSemgrep(javascriptChunks, {
      spawnProcess: unknownPath.spawnProcess as never,
      semgrepVersion: "1.176.0",
    })).rejects.toMatchObject({ code: "INVALID_RESULT" });
    expect(existsSync(unknownPath.getScanDirectory() ?? "")).toBe(false);

    const invalidSeverity = fakeSpawn(JSON.stringify({ results: [{
      check_id: "sentirev.javascript.eval-input",
      path: "chunk-000001.js",
      start: { line: 2 },
      end: { line: 2 },
      extra: { message: "Finding", metadata: { sentirev: { category: "code-execution", severity: "Urgent" } } },
    }] }));
    await expect(runSemgrep(javascriptChunks, {
      spawnProcess: invalidSeverity.spawnProcess as never,
      semgrepVersion: "1.176.0",
    })).rejects.toMatchObject({ code: "INVALID_RESULT" });

    const malformed = fakeSpawn("not-json");
    await expect(runSemgrep(javascriptChunks, {
      spawnProcess: malformed.spawnProcess as never,
      semgrepVersion: "1.176.0",
    })).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  it("sanitizes nonzero exit, output overflow, timeout, and cancellation while cleaning up", async () => {
    const failed = fakeSpawn("{}", 2);
    await expect(runSemgrep(javascriptChunks, {
      spawnProcess: failed.spawnProcess as never,
      semgrepVersion: "1.176.0",
    })).rejects.toMatchObject({ code: "NONZERO_EXIT" });
    expect(existsSync(failed.getScanDirectory() ?? "")).toBe(false);

    const overflow = fakeSpawn("x".repeat(100));
    await expect(runSemgrep(javascriptChunks, {
      spawnProcess: overflow.spawnProcess as never,
      semgrepVersion: "1.176.0",
      maxOutputBytes: 8,
    })).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    expect(existsSync(overflow.getScanDirectory() ?? "")).toBe(false);

    const timedOut = fakeSpawn(undefined, 0, "never");
    await expect(runSemgrep(javascriptChunks, {
      spawnProcess: timedOut.spawnProcess as never,
      semgrepVersion: "1.176.0",
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(existsSync(timedOut.getScanDirectory() ?? "")).toBe(false);

    const controller = new AbortController();
    const cancelled = fakeSpawn(undefined, 0, "never");
    const promise = runSemgrep(javascriptChunks, {
      spawnProcess: cancelled.spawnProcess as never,
      semgrepVersion: "1.176.0",
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(existsSync(cancelled.getScanDirectory() ?? "")).toBe(false);
  });

  it("exposes a digest for the pinned, repository-owned rule configuration", async () => {
    const digest = await getSemgrepConfigDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  });
});
