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
});

export type ServerEnvironment = z.infer<typeof serverEnvironment>;

export function getServerEnvironment(): ServerEnvironment {
  return serverEnvironment.parse(process.env);
}
