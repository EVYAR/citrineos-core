// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { AbstractModule, MemoryCache } from '@citrineos/base';
import { CallbackUrlNotifier } from '@modules/ocpp-router/callback-url-notifier.js';
import { aSystemConfig } from '@test/providers/system-config.js';
import { createTestContainer } from '@test/test-container.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const namespace = AbstractModule.CALLBACK_URL_CACHE_PREFIX + '1:station';
const url = 'http://adapter.test/callback';
let cache: MemoryCache;
let notifier: CallbackUrlNotifier;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  const { logger } = createTestContainer();
  cache = new MemoryCache(logger);
  notifier = new CallbackUrlNotifier({ cache, logger, config: aSystemConfig() });
  await cache.set('command', url, namespace);
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ accepted: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('terminal callback delivery', () => {
  it('atomically claims one terminal outcome when charger response races timeout', async () => {
    await Promise.all([
      notifier.notify(1, 'command', 'station', { status: 'Accepted' }),
      notifier.notify(1, 'command', 'station', { outcome: 'TIMED_OUT' }),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await cache.get('command', namespace)).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ status: 'Accepted' });
  });
  it('does nothing when there is no registered callback', async () => {
    await notifier.notify(1, 'missing', 'station', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([408, 429, 500, 503])(
    'retries retryable HTTP %i using the same terminal body',
    async (status) => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      const sending = notifier.notify(1, 'command', 'station', {
        outcome: 'CALL_ERROR',
        correlationId: 'command',
      });
      await vi.runAllTimersAsync();
      await sending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]?.body).toEqual(fetchMock.mock.calls[1]?.[1]?.body);
    },
  );
  it('never retries a permanent HTTP rejection', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 400 }));
    await notifier.notify(1, 'command', 'station', {});
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('bounds transport retries to three without resurrecting the callback', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('unreachable'));
    const sending = notifier.notify(1, 'command', 'station', {});
    await vi.runAllTimersAsync();
    await sending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await cache.get('command', namespace)).toBeNull();
  });
  it('keeps terminal callbacks isolated by correlation and station', async () => {
    await cache.set(
      'command',
      'http://adapter.test/other',
      AbstractModule.CALLBACK_URL_CACHE_PREFIX + '1:other',
    );
    await notifier.notify(1, 'command', 'station', {});
    expect(await cache.get('command', AbstractModule.CALLBACK_URL_CACHE_PREFIX + '1:other')).toBe(
      'http://adapter.test/other',
    );
  });
  it('does not claim another tenant callback with the same station and caller correlation', async () => {
    const otherNamespace = AbstractModule.CALLBACK_URL_CACHE_PREFIX + '2:station';
    await cache.set('command', 'http://adapter.test/tenant-2', otherNamespace);
    await notifier.notify(1, 'command', 'station', {});
    expect(await cache.get('command', otherNamespace)).toBe('http://adapter.test/tenant-2');
    await notifier.notify(2, 'command', 'station', {});
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      url,
      'http://adapter.test/tenant-2',
    ]);
  });
});
