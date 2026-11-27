// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { MemoryCache, RedisCache, type ICache } from '@citrineos/base';
import type { ILogObj, Logger } from 'tslog';
import type { OcpiConfig } from '../config/ocpi-types.js';
import { redisCacheConfigSchema } from '../config/redis-cache-config.js';

export function createOcpiCache(cache: OcpiConfig['cache'], logger?: Logger<ILogObj>): ICache {
  if (cache.redis !== undefined) {
    const redis = redisCacheConfigSchema.parse(cache.redis);
    return new RedisCache(
      redis.url !== undefined
        ? { url: redis.url }
        : { socket: { host: redis.host ?? 'localhost', port: redis.port ?? 6379 } },
      logger,
    );
  }
  if (!cache.memory) {
    throw new Error('A cache implementation must be set');
  }
  return new MemoryCache();
}
