import { z } from "zod";

const serverEnvironment = z.object({
  SENTIREV_DATABASE_URL: z.string().url(),
  SENTIREV_REDIS_URL: z.string().url(),
  SENTIREV_GITHUB_APP_ID: z.string().min(1),
  SENTIREV_GITHUB_APP_SLUG: z.string().min(1),
  SENTIREV_GITHUB_CLIENT_ID: z.string().min(1),
  SENTIREV_GITHUB_CLIENT_SECRET: z.string().min(1),
  SENTIREV_GITHUB_WEBHOOK_SECRET: z.string().min(1),
  SENTIREV_GITHUB_PRIVATE_KEY_PATH: z.string().min(1),
  SENTIREV_GITHUB_WEBHOOK_URL: z.string().url(),
  SENTIREV_GITHUB_TEST_REPOSITORY: z.string().regex(/^[^/]+\/[^/]+$/),
  SENTIREV_AUTH_SECRET: z.string().min(32),
  SENTIREV_APP_URL: z.string().url(),
  // It is required only when the Phase 003 AI adapter is enabled. Keeping it
  // optional here preserves static-only and Phase 001 boundaries.
  SENTIREV_OPENROUTER_API_KEY: z.string().min(1).optional(),
});

export type ServerEnvironment = z.infer<typeof serverEnvironment>;

export function getServerEnvironment(): ServerEnvironment {
  return serverEnvironment.parse(process.env);
}

export function getOwnerOpenRouterApiKey(): string {
  return z.object({ SENTIREV_OPENROUTER_API_KEY: z.string().min(1) })
    .parse(process.env)
    .SENTIREV_OPENROUTER_API_KEY;
}
