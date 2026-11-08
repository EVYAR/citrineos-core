// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, ILogObj } from 'tslog';
import {
  ChargingCalloutDeclineNotifier,
  type DeclineNotifierConfig,
} from '../../authorizer/ChargingCalloutDeclineNotifier.js';
import { InMemoryChargingCalloutStore } from '../../authorizer/ChargingCalloutLedger.js';

const TENANT = '00000000-0000-4000-8000-0000000000e2';
const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger<ILogObj>;
const cfg = (over: Partial<DeclineNotifierConfig> = {}): DeclineNotifierConfig => ({
  adapterBaseUrl: 'http://adapter.test',
  webhookToken: 'w'.repeat(32),
  tenantMap: { '1': TENANT },
  declineRetryBaseMs: 1000,
  declineRetryMaxMs: 60000,
  declineMaxAttempts: 3,
  declineRequestTimeoutMs: 3000,
  ...over,
});
const key = { tenantId: 1, ocppConnectionName: 'CP-001', authorizationId: 42, connectorId: 100 };

describe('ChargingCalloutDeclineNotifier', () => {
  let store: InMemoryChargingCalloutStore;
  let now: Date;
  beforeEach(() => {
    store = new InMemoryChargingCalloutStore();
    now = new Date('2026-10-19T10:00:00Z');
  });
  const declined = async (k = key) => {
    const b = await store.begin(k, now, 6000, 30000);
    if (b.kind !== 'CALLOUT') throw new Error('expected callout');
    await store.markDeclined(b.ref, 'core-decision:abc', now);
    return b.ref;
  };
  const make = (fetchImpl: typeof fetch, c = cfg()) =>
    new ChargingCalloutDeclineNotifier(store, c, logger, fetchImpl, () => now);

  it('cancels shutdown delivery without spending retries or abandoning durable receipts', async () => {
    const first = await declined();
    const second = await declined({ ...key, connectorId: 101 });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetchImpl = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          entered();
        }),
    );
    const notifier = make(fetchImpl as never);
    const flushing = notifier.flush();
    await started;
    await Promise.race([
      notifier.shutdown(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('shutdown stalled on delivery')), 200),
      ),
    ]);
    expect(await flushing).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const ref of [first, second]) {
      expect(await store.get(ref)).toMatchObject({ declineDeliveredAt: null, declineAttempts: 0 });
    }
    expect(await notifier.flush()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('posts the exact receipt the adapter validates, with the webhook credential, and marks it delivered', async () => {
    const ref = await declined();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ status: 200, json: async () => ({ fenced: true }) });
    expect(await make(fetchImpl as never).flush()).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `http://adapter.test/v1/charging/admission-callouts/${ref}/decline?token=${'w'.repeat(32)}`,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      schemaVersion: '1.0.0',
      tenantId: TENANT,
      coreEvidenceRef: 'core-decision:abc',
    }); // no driver/package fields
    expect((await store.get(ref))!.declineDeliveredAt).toEqual(now);
    expect(await make(fetchImpl as never).flush()).toBe(0); // delivered rows are not resent
  });

  it.each([false, undefined, 'true'])(
    'keeps the durable receipt pending when fenced is %s',
    async (fenced) => {
      const ref = await declined();
      const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ fenced }) });
      expect(await make(fetchImpl as never).flush()).toBe(0);
      expect((await store.get(ref))!).toMatchObject({
        declineDeliveredAt: null,
        declineAttempts: 1,
        lastDeclineError: 'ADAPTER_DECLINE_NOT_FENCED',
      });
    },
  );

  it('retries invalid JSON instead of acknowledging an empty successful HTTP response', async () => {
    const ref = await declined();
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON');
      },
    });
    expect(await make(fetchImpl as never).flush()).toBe(0);
    expect((await store.get(ref))!).toMatchObject({ declineDeliveredAt: null, declineAttempts: 1 });
  });

  it('never sends a receipt for a request that is pending or authorized', async () => {
    const pending = await store.begin(key, now, 6000, 30000);
    const other = await store.begin({ ...key, connectorId: 101 }, now, 6000, 30000);
    if (other.kind === 'CALLOUT') await store.markAuthorized(other.ref, now);
    expect(pending.kind).toBe('CALLOUT');
    const fetchImpl = vi.fn();
    expect(await make(fetchImpl as never).flush()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send without a canonical tenant mapping and keeps retrying later (slot stays held)', async () => {
    const ref = await declined();
    const fetchImpl = vi.fn();
    await make(fetchImpl as never, cfg({ tenantMap: {} })).flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    const row = (await store.get(ref))!;
    expect(row).toMatchObject({
      lastDeclineError: 'NO_TENANT_MAPPING',
      declineAttempts: 1,
      declineDeliveredAt: null,
      declineAbandoned: false,
    });
    expect(row.nextDeclineAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('retries a non-200 with backoff and abandons after the attempt budget, never inventing delivery', async () => {
    const ref = await declined();
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404 });
    const notifier = make(fetchImpl as never);
    await notifier.flush();
    expect(await store.dueDeclines(now, 10)).toHaveLength(0); // backing off
    for (let i = 0; i < 2; i += 1) {
      now = new Date(now.getTime() + 120_000);
      await notifier.flush();
    }
    const row = (await store.get(ref))!;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(row).toMatchObject({
      declineAttempts: 3,
      declineAbandoned: true,
      declineDeliveredAt: null,
      lastDeclineError: 'ADAPTER_HTTP_404',
    });
    now = new Date(now.getTime() + 600_000);
    await notifier.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // abandoned: no more sends
  });

  it('survives a restart: a new notifier instance delivers a decline committed earlier', async () => {
    const ref = await declined();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ status: 200, json: async () => ({ fenced: true }) });
    await make(fetchImpl as never).flush();
    expect((await store.get(ref))!.lastDeclineError).toContain('ADAPTER_UNREACHABLE');
    now = new Date(now.getTime() + 120_000);
    expect(await make(fetchImpl as never).flush()).toBe(1); // fresh instance, same durable rows
  });

  it('starts recovery after the interval and stops the retry timer without querying an unready boot schema', async () => {
    vi.useFakeTimers();
    const due = vi.spyOn(store, 'dueDeclines');
    const notifier = make(vi.fn() as never);
    try {
      notifier.start(1000);
      notifier.start(1000);
      expect(due).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(due).toHaveBeenCalledTimes(1);
      notifier.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(due).toHaveBeenCalledTimes(1);
    } finally {
      notifier.stop();
      vi.useRealTimers();
    }
  });

  it('concurrent flushes share one pass (one POST per receipt)', async () => {
    await declined();
    let finish!: () => void;
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 200, json: async () => ({ fenced: true }) });
        }),
    );
    const notifier = make(fetchImpl as never);
    const a = notifier.flush();
    const b = notifier.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    finish();
    await Promise.all([a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

it('awaits an active flush and cancels the retry timer before database shutdown', async () => {
  let complete!: (rows: never[]) => void;
  const pending = new Promise<never[]>((resolve) => {
    complete = resolve;
  });
  const store = { dueDeclines: vi.fn(() => pending) } as unknown as InMemoryChargingCalloutStore;
  const notifier = new ChargingCalloutDeclineNotifier(store, cfg(), logger);
  notifier.start();
  const flushing = notifier.flush();
  let stopped = false;
  const shutdown = notifier.shutdown().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  complete([]);
  await shutdown;
  await flushing;
  expect(stopped).toBe(true);
});
