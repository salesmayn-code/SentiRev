import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const secretPatterns = [
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  },
  {
    label: "provider API key",
    pattern: /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/u,
  },
] as const;

function repositoryFiles(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to enumerate repository files");
  }

  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

describe("repository secret boundary", () => {
  it("contains no recognizable committed or unignored credentials", () => {
    const findings: string[] = [];

    for (const file of repositoryFiles()) {
      let contents: Buffer;
      try {
        contents = readFileSync(file);
      } catch {
        continue;
      }
      if (contents.includes(0)) {
        continue;
      }

      const text = contents.toString("utf8");
      for (const { label, pattern } of secretPatterns) {
        if (pattern.test(text)) {
          findings.push(`${file}: ${label}`);
        }
      }
    }

    expect(findings, findings.join("\n")).toEqual([]);
  });
});
