import { Redis } from "@upstash/redis";

let client: Redis | null = null;

export function isRedisConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

export function getRedis(): Redis {
  client ??= Redis.fromEnv();
  return client;
}
