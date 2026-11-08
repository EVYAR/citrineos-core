// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache, RedisCache } from '@citrineos/base';
import { ocpiCacheFromEnv } from '@ocpi/config/redis-cache-config.js';
import { createOcpiCache } from '@ocpi/util/create-ocpi-cache.js';

vi.mock('@citrineos/base', () => ({
  MemoryCache: vi.fn(class MemoryCache {}),
  RedisCache: vi.fn(class RedisCache {}),
}));

beforeEach(() => vi.clearAllMocks());

describe('OCPI Docker cache environment and production factory', () => {
  it.each([
    'redis://user:password@redis.internal:6379/0',
    'rediss://:password@redis.internal:6380/0',
  ])('passes authentication and TLS URL intact to RedisCache', (url) => {
    createOcpiCache(ocpiCacheFromEnv({ REDIS_URL: url }));
    expect(RedisCache).toHaveBeenCalledWith({ url }, undefined);
    expect(MemoryCache).not.toHaveBeenCalled();
  });

  it.each(['', 'invalid', 'https://user:password@host', 'redis://host/invalid'])(
    'fails closed for an explicitly invalid URL',
    (url) => {
      expect(() => createOcpiCache(ocpiCacheFromEnv({ REDIS_URL: url }))).toThrow();
      expect(MemoryCache).not.toHaveBeenCalled();
      expect(RedisCache).not.toHaveBeenCalled();
    },
  );

  it.each([{ REDIS_HOST: 'host' }, { REDIS_PORT: '6379' }])(
    'rejects ambiguous environment configuration',
    (env) => {
      expect(() => ocpiCacheFromEnv({ ...env, REDIS_URL: 'redis://host' })).toThrow(
        'cannot be combined',
      );
    },
  );

  it('supports the optional upstream host profile and memory fallback', () => {
    createOcpiCache(ocpiCacheFromEnv({ REDIS_HOST: 'redis.internal', REDIS_PORT: '6380' }));
    expect(RedisCache).toHaveBeenLastCalledWith(
      { socket: { host: 'redis.internal', port: 6380 } },
      undefined,
    );
    createOcpiCache({ redis: {} });
    expect(RedisCache).toHaveBeenLastCalledWith(
      { socket: { host: 'localhost', port: 6379 } },
      undefined,
    );
    createOcpiCache(ocpiCacheFromEnv({}));
    expect(MemoryCache).toHaveBeenCalledTimes(1);
  });

  it.each([
    { REDIS_HOST: '' },
    { REDIS_HOST: 'host', REDIS_PORT: '6379junk' },
    { REDIS_PORT: '6379' },
  ])('rejects invalid host profiles', (env) => {
    expect(() => ocpiCacheFromEnv(env)).toThrow();
  });

  it('validates URL config again at the factory boundary', () => {
    expect(() => createOcpiCache({ memory: true, redis: { url: 'invalid' } })).toThrow();
    expect(MemoryCache).not.toHaveBeenCalled();
  });
});
