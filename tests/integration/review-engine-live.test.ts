import { describe, expect, it } from "vitest";

import { PRIMARY_MODEL, PROVIDER_MODELS } from "@/lib/review/providers/openrouter";
import { createReviewRuntime } from "@/lib/review/runtime";

const syntheticDiff = [
  "diff --git a/src/phase003-live.ts b/src/phase003-live.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/phase003-live.ts",
  "@@ -0,0 +1 @@",
  "+const user = req.query.name; db.query(`SELECT * FROM users WHERE name = '${user}'`);",
].join("\n");

const apiKey = process.env.SENTIREV_OPENROUTER_API_KEY;

describe.sequential("Phase 003 controlled live provider smoke", () => {
  it.skipIf(!apiKey)("proves parsed synthetic diff reaches the exact OpenRouter model", async () => {
    expect(PROVIDER_MODELS).toEqual([PRIMARY_MODEL]);
    const runtime = createReviewRuntime(apiKey!, { timeoutMs: 60_000 });
    const chunks = runtime.parseDiff(syntheticDiff);
    const [result] = await runtime.runAi(chunks, new AbortController().signal);
    // Do not include the response object in the assertion: it is untrusted
    // provider data and must not be echoed into test output or evidence.
    expect(result.engineIdentifier).toBe(PRIMARY_MODEL);
    expect(result.code).toBe("SUCCEEDED");
  }, 70_000);
});
