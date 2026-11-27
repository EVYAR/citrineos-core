// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

const redisUrlSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return (
        value === value.trim() &&
        (url.protocol === 'redis:' || url.protocol === 'rediss:') &&
        Boolean(url.hostname) &&
        !url.search &&
        !url.hash &&
        (!url.pathname || /^\/\d*$/.test(url.pathname))
      );
    } catch {
      return false;
    }
  },
  { message: 'Redis URL must use redis:// or rediss:// with a host and optional database number' },
);

export const redisCacheConfigSchema = z
  .object({
    url: redisUrlSchema.optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .refine(
    (config) =>
      config.url === undefined || (config.host === undefined && config.port === undefined),
    {
      message: 'Redis URL cannot be combined with Redis host or port',
    },
  );

export function ocpiCacheFromEnv(env: NodeJS.ProcessEnv) {
  if (env.REDIS_URL !== undefined) {
    if (env.REDIS_HOST !== undefined || env.REDIS_PORT !== undefined) {
      throw new Error('REDIS_URL cannot be combined with REDIS_HOST or REDIS_PORT');
    }
    return { redis: redisCacheConfigSchema.parse({ url: env.REDIS_URL }) };
  }
  if (env.REDIS_HOST !== undefined) {
    return {
      redis: redisCacheConfigSchema.parse({
        host: env.REDIS_HOST,
        port: env.REDIS_PORT === undefined ? 6379 : Number(env.REDIS_PORT),
      }),
    };
  }
  if (env.REDIS_PORT !== undefined) {
    throw new Error('REDIS_PORT requires REDIS_HOST');
  }
  return { memory: true };
}
