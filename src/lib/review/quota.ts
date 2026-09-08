import { randomUUID } from "node:crypto";

/**
 * The quota boundary deliberately accepts only the Redis operation it needs.
 * The implementation can therefore use IORedis in production and an atomic
 * fake in unit tests without coupling review code to a Redis client library.
 */
export type RedisQuotaClient = {
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
};

export const OPENROUTER_QUOTA_LIMITS = {
  attemptsPerRollingMinute: 20,
  attemptsPerUtcDay: 50,
  rollingMinuteMs: 60_000,
} as const;

export const OPENROUTER_QUOTA_MINUTE_KEY = "sentirev:openrouter:quota:minute";
const OPENROUTER_QUOTA_DAY_KEY_PREFIX = "sentirev:openrouter:quota:day:";

/**
 * Redis executes this script atomically. A permit is recorded only when both
 * the rolling-minute and UTC-day budgets are available. The member is an
 * opaque per-call id; it is never part of a Redis key.
 */
export const OPENROUTER_QUOTA_SCRIPT = `
local nowMs = tonumber(ARGV[1])
local rollingMinuteMs = tonumber(ARGV[2])
local minuteLimit = tonumber(ARGV[3])
local dayLimit = tonumber(ARGV[4])
local permitId = ARGV[5]
local dayExpirySeconds = tonumber(ARGV[6])

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", nowMs - rollingMinuteMs)

local dayCount = tonumber(redis.call("GET", KEYS[2]) or "0")
if dayCount >= dayLimit then
  return { 0, "daily_quota_exhausted" }
end

local minuteCount = tonumber(redis.call("ZCARD", KEYS[1]) or "0")
if minuteCount >= minuteLimit then
  return { 0, "rate_limited" }
end

redis.call("ZADD", KEYS[1], nowMs, permitId)
redis.call("PEXPIRE", KEYS[1], rollingMinuteMs + 1_000)
redis.call("INCR", KEYS[2])
redis.call("EXPIREAT", KEYS[2], dayExpirySeconds)
return { 1, "granted" }
`;

export type QuotaDenialReason = "rate_limited" | "daily_quota_exhausted";

export type OpenRouterQuotaPermit =
  | { granted: true; permitId: string }
  | { granted: false; reason: QuotaDenialReason };

export type OpenRouterQuotaDependencies = {
  nowMs?: () => number;
  createPermitId?: () => string;
};

export type OpenRouterQuota = {
  acquirePermit(): Promise<OpenRouterQuotaPermit>;
};

function utcDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${OPENROUTER_QUOTA_DAY_KEY_PREFIX}${year}-${month}-${day}`;
}

function nextUtcDayExpirySeconds(nowMs: number): number {
  const date = new Date(nowMs);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1_000,
  );
}

function assertNowMs(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Quota clock must return a non-negative integer timestamp");
  }
}

function parseRedisResult(value: unknown): OpenRouterQuotaPermit {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Redis quota script returned an invalid result");
  }

  const [status, reason] = value;
  if (status === 1 && reason === "granted") {
    return { granted: true, permitId: "" };
  }
  if (status === 0 && (reason === "rate_limited" || reason === "daily_quota_exhausted")) {
    return { granted: false, reason };
  }
  throw new Error("Redis quota script returned an invalid result");
}

/**
 * Build the OpenRouter admission boundary. Every successful acquire reserves
 * exactly one external request. Callers must not retry a denied permit.
 */
export function createOpenRouterQuota(
  redis: RedisQuotaClient,
  dependencies: OpenRouterQuotaDependencies = {},
): OpenRouterQuota {
  const now = dependencies.nowMs ?? Date.now;
  const createPermitId = dependencies.createPermitId ?? randomUUID;

  return {
    async acquirePermit(): Promise<OpenRouterQuotaPermit> {
      const nowMs = now();
      assertNowMs(nowMs);

      const permitId = createPermitId();
      if (typeof permitId !== "string" || permitId.length === 0) {
        throw new Error("Quota permit id factory returned an invalid id");
      }

      const result = parseRedisResult(
        await redis.eval(
          OPENROUTER_QUOTA_SCRIPT,
          2,
          OPENROUTER_QUOTA_MINUTE_KEY,
          utcDayKey(nowMs),
          nowMs,
          OPENROUTER_QUOTA_LIMITS.rollingMinuteMs,
          OPENROUTER_QUOTA_LIMITS.attemptsPerRollingMinute,
          OPENROUTER_QUOTA_LIMITS.attemptsPerUtcDay,
          permitId,
          nextUtcDayExpirySeconds(nowMs),
        ),
      );

      if (!result.granted) return result;
      return { granted: true, permitId };
    },
  };
}

export async function acquireOpenRouterPermit(
  redis: RedisQuotaClient,
  dependencies: OpenRouterQuotaDependencies = {},
): Promise<OpenRouterQuotaPermit> {
  return createOpenRouterQuota(redis, dependencies).acquirePermit();
}
