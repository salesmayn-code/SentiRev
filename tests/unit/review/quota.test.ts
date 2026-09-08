import { describe, expect, it } from "vitest";

import {
  createOpenRouterQuota,
  OPENROUTER_QUOTA_LIMITS,
  OPENROUTER_QUOTA_MINUTE_KEY,
  OPENROUTER_QUOTA_SCRIPT,
  type RedisQuotaClient,
} from "@/lib/review/quota";

type SortedMember = { score: number; member: string };

/**
 * This fake models the Redis commands used by the Lua script and serializes
 * each eval call like Redis's single-threaded command execution. It records
 * the keys and arguments so the tests also prove that sensitive review data
 * cannot become part of the quota key.
 */
class FakeRedis implements RedisQuotaClient {
  readonly minuteMembers: SortedMember[] = [];
  readonly dayCounts = new Map<string, { count: number; expiresAt: number }>();
  readonly evalCalls: Array<{
    script: string;
    numberOfKeys: number;
    arguments_: Array<string | number>;
  }> = [];

  private queue = Promise.resolve();

  async eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      this.evalCalls.push({ script, numberOfKeys, arguments_ });
      expect(script).toBe(OPENROUTER_QUOTA_SCRIPT);
      expect(numberOfKeys).toBe(2);

      const [minuteKey, dayKey, nowMsArg, rollingMinuteMsArg, minuteLimitArg, dayLimitArg, permitIdArg, dayExpirySecondsArg] = arguments_;
      if (minuteKey !== OPENROUTER_QUOTA_MINUTE_KEY) {
        throw new Error("unexpected minute key");
      }
      if (typeof dayKey !== "string" || !/^sentirev:openrouter:quota:day:\d{4}-\d{2}-\d{2}$/u.test(dayKey)) {
        throw new Error("unexpected day key");
      }
      if (
        typeof nowMsArg !== "number" ||
        typeof rollingMinuteMsArg !== "number" ||
        typeof minuteLimitArg !== "number" ||
        typeof dayLimitArg !== "number" ||
        typeof permitIdArg !== "string" ||
        typeof dayExpirySecondsArg !== "number"
      ) {
        throw new Error("unexpected quota argument");
      }

      const nowMs = nowMsArg;
      for (const [key, value] of this.dayCounts) {
        if (value.expiresAt <= nowMs) this.dayCounts.delete(key);
      }
      for (let index = this.minuteMembers.length - 1; index >= 0; index -= 1) {
        if (this.minuteMembers[index].score <= nowMs - rollingMinuteMsArg) {
          this.minuteMembers.splice(index, 1);
        }
      }

      const dayCount = this.dayCounts.get(dayKey)?.count ?? 0;
      if (dayCount >= dayLimitArg) return [0, "daily_quota_exhausted"];
      if (this.minuteMembers.length >= minuteLimitArg) return [0, "rate_limited"];

      this.minuteMembers.push({ score: nowMs, member: permitIdArg });
      this.dayCounts.set(dayKey, {
        count: dayCount + 1,
        expiresAt: dayExpirySecondsArg * 1_000,
      });
      return [1, "granted"];
    } finally {
      release();
    }
  }
}

function fixedClock(start: number): { nowMs: () => number; set: (value: number) => void } {
  let current = start;
  return {
    nowMs: () => current,
    set: (value) => {
      current = value;
    },
  };
}

describe("OpenRouter free-tier quota", () => {
  it("admits at most 20 concurrent attempts and returns a sanitized rate limit", async () => {
    const clock = fixedClock(Date.UTC(2026, 0, 1, 12, 0, 0));
    const redis = new FakeRedis();
    const quota = createOpenRouterQuota(redis, {
      nowMs: clock.nowMs,
      createPermitId: (() => {
        let sequence = 0;
        return () => `permit-${sequence += 1}`;
      })(),
    });

    const results = await Promise.all(
      Array.from({ length: OPENROUTER_QUOTA_LIMITS.attemptsPerRollingMinute + 1 }, () =>
        quota.acquirePermit(),
      ),
    );

    expect(results.filter((result) => result.granted)).toHaveLength(20);
    expect(results.filter((result) => !result.granted)).toEqual([
      { granted: false, reason: "rate_limited" },
    ]);
    expect(redis.minuteMembers).toHaveLength(20);
    expect(new Set(results.filter((result) => result.granted).map((result) => result.permitId))).toHaveLength(20);
    expect(redis.evalCalls.every((call) => call.arguments_.every((value) => !String(value).includes("repo") && !String(value).includes("secret")))).toBe(true);
  });

  it("admits a new attempt after the rolling minute expires", async () => {
    const clock = fixedClock(Date.UTC(2026, 0, 1, 12, 0, 0));
    const redis = new FakeRedis();
    const quota = createOpenRouterQuota(redis, { nowMs: clock.nowMs });

    await Promise.all(Array.from({ length: 20 }, () => quota.acquirePermit()));
    expect((await quota.acquirePermit()).granted).toBe(false);

    clock.set(Date.UTC(2026, 0, 1, 12, 1, 0, 1));
    expect(await quota.acquirePermit()).toMatchObject({ granted: true });
    expect(redis.minuteMembers).toHaveLength(1);
  });

  it("enforces 50 attempts per UTC day and permits the next UTC day", async () => {
    const firstDay = Date.UTC(2026, 0, 1, 0, 0, 0);
    const clock = fixedClock(firstDay);
    const redis = new FakeRedis();
    const quota = createOpenRouterQuota(redis, { nowMs: clock.nowMs });

    const granted: Array<{ granted: true; permitId: string }> = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await quota.acquirePermit();
      expect(result.granted).toBe(true);
      if (result.granted) granted.push(result);
      clock.set(firstDay + (attempt + 1) * 60_001);
    }

    expect(granted).toHaveLength(50);
    expect(await quota.acquirePermit()).toEqual({
      granted: false,
      reason: "daily_quota_exhausted",
    });

    clock.set(Date.UTC(2026, 0, 2, 0, 0, 0, 1));
    expect((await quota.acquirePermit()).granted).toBe(true);
  });

  it("does not expose provider, repository, diff, or secret data in its result", async () => {
    const redis = new FakeRedis();
    const quota = createOpenRouterQuota(redis, {
      nowMs: () => Date.UTC(2026, 0, 1, 12, 0, 0),
      createPermitId: () => "opaque-permit-id",
    });

    const result = await quota.acquirePermit();
    expect(result).toEqual({ granted: true, permitId: "opaque-permit-id" });
    expect(JSON.stringify(result)).not.toMatch(/repository|diff|secret|api[_-]?key|provider/iu);
  });
});
