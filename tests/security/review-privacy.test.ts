import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/client";

describe("Phase 003 privacy storage boundary", () => {
  it("has no durable columns for raw diffs, prompts, provider bodies, headers, keys, or temporary paths", async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('FoundationJob', 'Finding', 'FindingProvenance', 'EngineRun')
    `;
    const forbidden = /(?:raw.*(?:diff|response|body)|prompt|header|api.?key|secret|temporary|temp.*path)/iu;
    expect(rows.map((row) => row.column_name).filter((column) => forbidden.test(column))).toEqual([]);
  });
});
