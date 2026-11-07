// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import {
  ChargingCalloutDeclineNotifier,
  type DeclineNotifierConfig,
} from '@services/authorizer/ChargingCalloutDeclineNotifier.js';
import { InMemoryChargingCalloutStore } from '@services/authorizer/ChargingCalloutLedger.js';
import { createTestContainer } from '@test/test-container.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const tenant = 'db5dbd46-33a2-0000-0000-000000000001';
const key = { tenantId: 1, ocppConnectionName: 'station', authorizationId: 42, connectorId: 100 };
const cfg = (overrides: Partial<DeclineNotifierConfig> = {}): DeclineNotifierConfig => ({
  adapterBaseUrl: 'http://adapter.test',
  webhookToken: 'w'.repeat(32),
  tenantMap: { '1': tenant },
  declineRetryBaseMs: 100,
  declineRetryMaxMs: 1000,
  declineMaxAttempts: 3,
  declineRequestTimeoutMs: 1000,
  ...overrides,
});
let store: InMemoryChargingCalloutStore;
let now: Date;
beforeEach(() => {
  store = new InMemoryChargingCalloutStore();
  now = new Date('2026-11-07T12:00:00Z');
});
async function decline() {
  const begun = await store.begin(key, now, 1000, 30000);
  if (begun.kind !== 'CALLOUT') throw new Error('fixture is fenced');
  await store.markDeclined(begun.ref, 'core-decision:synthetic', now);
  return begun.ref;
}
function make(fetchImpl: typeof fetch, overrides: Partial<DeclineNotifierConfig> = {}) {
  const { logger } = createTestContainer();
  return new ChargingCalloutDeclineNotifier(store, cfg(overrides), logger, fetchImpl, () => now);
}
describe('durable decline receipt contract', () => {
  it('posts exact canonical tenant evidence and requires confirmed fencing', async () => {
    const ref = await decline();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ fenced: true }));
    expect(await make(fetchImpl).flush()).toBe(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `http://adapter.test/v1/charging/admission-callouts/${ref}/decline?token=${'w'.repeat(32)}`,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      schemaVersion: '1.0.0',
      tenantId: tenant,
      coreEvidenceRef: 'core-decision:synthetic',
    });
    expect(await make(fetchImpl).flush()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([false, undefined, 'true'])('does not acknowledge fenced=%s', async (fenced) => {
    const ref = await decline();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ fenced }));
    expect(await make(fetchImpl).flush()).toBe(0);
    expect(await store.get(ref)).toMatchObject({
      declineDeliveredAt: null,
      declineAttempts: 1,
      lastDeclineError: 'ADAPTER_DECLINE_NOT_FENCED',
    });
  });
  it('never invents delivery from HTTP success with malformed JSON', async () => {
    const ref = await decline();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(''));
    expect(await make(fetchImpl).flush()).toBe(0);
    expect(await store.get(ref)).toMatchObject({ declineDeliveredAt: null, declineAttempts: 1 });
  });
  it('does not send unknown tenant evidence or a pending/authorized decision', async () => {
    const ref = await decline();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await make(fetchImpl, { tenantMap: {} }).flush()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await store.get(ref)).toMatchObject({ lastDeclineError: 'NO_TENANT_MAPPING' });
    store = new InMemoryChargingCalloutStore();
    const b = await store.begin(key, now, 1000, 30000);
    if (b.kind !== 'CALLOUT') throw new Error('fixture');
    expect(await make(fetchImpl).flush()).toBe(0);
    await store.markAuthorized(b.ref, now);
    expect(await make(fetchImpl).flush()).toBe(0);
  });
  it('recovers durable retries across notifier restart without crossing attempt budget', async () => {
    const ref = await decline();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    for (let n = 0; n < 4; n++) {
      await make(fetchImpl).flush();
      now = new Date(now.getTime() + 2000);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await store.get(ref)).toMatchObject({
      declineAttempts: 3,
      declineAbandoned: true,
      declineDeliveredAt: null,
    });
  });
  it('cancels active delivery on shutdown without consuming a retry', async () => {
    const ref = await decline();
    let entered: () => void = () => {
      throw new Error('not started');
    };
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
          entered();
        }),
    );
    const notifier = make(fetchImpl);
    const flush = notifier.flush();
    await started;
    await notifier.shutdown();
    expect(await flush).toBe(0);
    expect(await store.get(ref)).toMatchObject({ declineAttempts: 0, declineAbandoned: false });
  });
  it('coalesces concurrent flushes and waits for settlement before shutdown', async () => {
    await decline();
    let finish: (response: Response) => void = () => {
      throw new Error('not entered');
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const notifier = make(fetchImpl);
    const first = notifier.flush();
    const second = notifier.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    finish(Response.json({ fenced: true }));
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    await notifier.shutdown();
  });
});
