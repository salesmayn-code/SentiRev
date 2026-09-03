import IORedis from "ioredis";

import { getServerEnvironment } from "@/lib/env";

let connection: IORedis | undefined;

export function getRedisConnection(): IORedis {
  connection ??= new IORedis(getServerEnvironment().SENTIREV_REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (!connection) return;
  await connection.quit();
  connection = undefined;
}
