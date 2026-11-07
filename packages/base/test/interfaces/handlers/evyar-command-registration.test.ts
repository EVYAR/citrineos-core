// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { CacheNamespace } from '@interfaces/cache/types.js';
import { OcppSender } from '@interfaces/handlers/ocpp-sender.js';
import type { SendCallArgs } from '@interfaces/handlers/i-ocpp-sender.js';
import type { IMessageSender } from '@interfaces/messages/message-sender.js';
import { EventGroup, OCPPVersion, OCPP_CallAction } from '@citrineos/types';
import { MemoryCache } from '../../../src/cache/memory.js';
import { aSystemConfig } from '../../providers/system-config.js';
import { Logger, type ILogObj } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';
class RecordingSender implements IMessageSender {
  sendRequest = vi.fn<IMessageSender['sendRequest']>().mockResolvedValue({ success: true });
  sendResponse = vi.fn<IMessageSender['sendResponse']>().mockResolvedValue({ success: true });
  send = vi.fn<IMessageSender['send']>().mockResolvedValue({ success: true });
  shutdown = vi.fn<IMessageSender['shutdown']>().mockResolvedValue(undefined);
}
function args(tenantId = 1): SendCallArgs {
  return {
    tenantId,
    ocppConnectionName: 'same-station',
    correlationId: 'chosen-id',
    protocol: OCPPVersion.OCPP2_0_1,
    action: OCPP_CallAction.Reset,
    eventGroup: EventGroup.Configuration,
    payload: { type: 'Immediate' },
    callbackUrl: `http://adapter.test/${tenantId}/callback`,
  };
}
async function fixture() {
  const logger = new Logger<ILogObj>({ minLevel: 6 });
  const cache = new MemoryCache(logger);
  const sender = new RecordingSender();
  await cache.set(
    '1:same-station',
    JSON.stringify({
      id: 'test',
      timeConnected: new Date().toISOString(),
      protocol: OCPPVersion.OCPP2_0_1,
      allowUnknownChargingStations: false,
    }),
    CacheNamespace.Connections,
  );
  const ocpp = new OcppSender({ config: aSystemConfig(), cache, sender, logger });
  return { cache, sender, ocpp };
}
afterEach(() => vi.restoreAllMocks());
describe('EVYAR command dispatch registration', () => {
  it('awaits callback storage before sending a command that can answer immediately', async () => {
    const { cache, sender, ocpp } = await fixture();
    const set = cache.set.bind(cache);
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(cache, 'set').mockImplementation(async (key, value, namespace, expiry) => {
      await barrier;
      return set(key, value, namespace, expiry);
    });
    const sending = ocpp.sendCall(args());
    await Promise.resolve();
    expect(sender.sendRequest).not.toHaveBeenCalled();
    release();
    expect((await sending).success).toBe(true);
    expect(await cache.get('chosen-id', 'CALLBACK_URL_1:same-station')).toBe(
      'http://adapter.test/1/callback',
    );
    expect(sender.sendRequest).toHaveBeenCalledOnce();
  });
  it.each(['rejected', 'unavailable'])(
    'does not dispatch when callback registration is %s',
    async (kind) => {
      const { cache, sender, ocpp } = await fixture();
      const write = vi.spyOn(cache, 'set');
      if (kind === 'rejected') write.mockResolvedValue(false);
      else write.mockRejectedValue(new Error('cache unavailable'));
      expect(await ocpp.sendCall(args())).toMatchObject({
        success: false,
        payload: { outcome: 'CALLBACK_REGISTRATION_FAILED', correlationId: 'chosen-id' },
      });
      expect(sender.sendRequest).not.toHaveBeenCalled();
    },
  );
  it('forwards absence of module-side connection evidence to the authoritative router', async () => {
    const { cache, sender, ocpp } = await fixture();
    await cache.remove('1:same-station', CacheNamespace.Connections);
    expect((await ocpp.sendCall(args())).success).toBe(true);
    expect(sender.sendRequest).toHaveBeenCalledOnce();
    expect(await cache.get('chosen-id', 'CALLBACK_URL_1:same-station')).not.toBeNull();
  });
  it('removes only its own callback registration on protocol mismatch', async () => {
    const { cache, sender, ocpp } = await fixture();
    await cache.set('chosen-id', 'http://adapter.test/2/callback', 'CALLBACK_URL_2:same-station');
    expect(
      await ocpp.sendCall({ ...args(), protocol: OCPPVersion.OCPP1_6, payload: { type: 'Soft' } }),
    ).toMatchObject({
      success: false,
      payload: { outcome: 'DISPATCH_FAILED', error: { code: 'PROTOCOL_MISMATCH' } },
    });
    expect(sender.sendRequest).not.toHaveBeenCalled();
    expect(await cache.get('chosen-id', 'CALLBACK_URL_1:same-station')).toBeNull();
    expect(await cache.get('chosen-id', 'CALLBACK_URL_2:same-station')).toBe(
      'http://adapter.test/2/callback',
    );
  });
  it('isolates caller-chosen correlations across same-name stations in two tenants', async () => {
    const { cache, ocpp } = await fixture();
    await Promise.all([ocpp.sendCall(args(1)), ocpp.sendCall(args(2))]);
    expect(await cache.get('chosen-id', 'CALLBACK_URL_1:same-station')).toBe(
      'http://adapter.test/1/callback',
    );
    expect(await cache.get('chosen-id', 'CALLBACK_URL_2:same-station')).toBe(
      'http://adapter.test/2/callback',
    );
  });
});
