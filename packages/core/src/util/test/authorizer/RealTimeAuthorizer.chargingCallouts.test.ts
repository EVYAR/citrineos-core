// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import {
  AuthorizationStatusEnum,
  AuthorizationWhitelistEnum,
  type ConnectorDto,
  type EvseDto,
  type IMessageContext,
  type SystemConfig,
} from '@citrineos/base';
import type { Authorization } from '@dal/layers/sequelize/index.js';
import type { ILocationRepository } from '@dal/interfaces/repositories.js';
import { beforeEach, describe, expect, it, type Mocked, vi } from 'vitest';
import { RealTimeAuthorizer } from '../../authorizer/RealTimeAuthorizer.js';
import { InMemoryChargingCalloutStore } from '../../authorizer/ChargingCalloutLedger.js';
import type { ChargingCalloutDeclineNotifier } from '../../authorizer/ChargingCalloutDeclineNotifier.js';
import { createTestContainer, getTestInstance } from '../../../test/testContainer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const evse = { id: 10, evseTypeId: 1 } as EvseDto;
const connector = { id: 100, connectorId: 1 } as ConnectorDto;
const context = (): IMessageContext => ({ tenantId: 1, ocppConnectionName: 'CP-001', correlationId: 'c', timestamp: new Date().toISOString() }) as IMessageContext;
const authorization = (over: Record<string, unknown> = {}): Authorization =>
  ({ id: 42, realTimeAuthUrl: 'http://adapter.test/v1/authorize', realTimeAuth: AuthorizationWhitelistEnum.Never, status: AuthorizationStatusEnum.Accepted, tenantPartnerId: 7, idToken: 'F00B4C', idTokenType: 'ISO14443', realTimeAuthLastAttempt: undefined, save: vi.fn().mockResolvedValue(undefined), ...over }) as unknown as Authorization;
const repo = (): Mocked<ILocationRepository> => ({ readChargingStationByStationId: vi.fn().mockResolvedValue({ locationId: 5, evses: [] }) }) as unknown as Mocked<ILocationRepository>;
const allowed = (value: string) => ({ ok: true, status: 200, json: async () => ({ timestamp: new Date().toISOString(), data: { allowed: value } }) });
const config = (extra: Partial<SystemConfig> = {}): SystemConfig =>
  ({ realTimeAuthRequestTimeoutMs: 3000, realTimeAuthChargingCallouts: { enabled: true, tenantMap: { '1': '00000000-0000-4000-8000-0000000000e2' }, fenceSeconds: 30, declineRetryBaseMs: 1000, declineRetryMaxMs: 300000, declineMaxAttempts: 50, declineRequestTimeoutMs: 3000 }, ...extra }) as unknown as SystemConfig;

describe('RealTimeAuthorizer durable charging callouts (CGP-0012)', () => {
  const { container } = createTestContainer();
  let store: InMemoryChargingCalloutStore;
  let notifier: { flush: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;

  const build = (cfg: SystemConfig = config()) =>
    getTestInstance(container, RealTimeAuthorizer, { locationRepository: repo(), config: cfg, chargingCalloutStore: store, declineNotifier: notifier as unknown as ChargingCalloutDeclineNotifier });
  const onlyRow = () => [...store.rows.values()][0]!;

  beforeEach(() => {
    store = new InMemoryChargingCalloutStore();
    notifier = { flush: vi.fn().mockResolvedValue(0), start: vi.fn() };
    fetchMock = vi.fn().mockResolvedValue(allowed('ALLOWED'));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('pins a Core-generated chargingCalloutRef into the callout body and authorizes the same row', async () => {
    const result = await build().authorize(authorization(), context(), evse, connector);
    expect(result).toBe(AuthorizationStatusEnum.Accepted);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.chargingCalloutRef).toMatch(UUID);
    expect(body.chargingCalloutRef).toBe(onlyRow().id);
    expect(body.targetSource).toBe('EXPLICIT');
    expect(onlyRow()).toMatchObject({ state: 'AUTHORIZED', tenantId: 1, ocppConnectionName: 'CP-001', authorizationId: 42, connectorId: 100 });
    expect(notifier.flush).not.toHaveBeenCalled(); // an accepted start never emits a decline
  });

  it.each([
    [AuthorizationStatusEnum.Accepted, 'BLOCKED', AuthorizationStatusEnum.Blocked, 'DECLINED_BEFORE_POWER'],
    [AuthorizationStatusEnum.Blocked, 'ALLOWED', AuthorizationStatusEnum.Accepted, 'AUTHORIZED'],
  ] as const)('revalidates an explicit target despite cached %s when ordinary replay is enabled', async (cached, decision, expected, state) => {
    fetchMock.mockResolvedValue(allowed(decision));
    const auth = authorization({ realTimeAuthTimeout: 15, realTimeAuthLastAttempt: {
      timestamp: new Date().toISOString(), result: cached, ocppConnectionName: 'CP-001', connectorId: 100,
    } });
    expect(await build(config({ realTimeAuthReplayLastAttempt: true })).authorize(auth, context(), evse, connector)).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onlyRow().state).toBe(state);
  });

  it('commits DECLINED_BEFORE_POWER with durable evidence BEFORE answering when the callout times out', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const result = await build().authorize(authorization(), context(), evse, connector);
    expect(result).toBe(AuthorizationStatusEnum.Invalid);
    expect(onlyRow().state).toBe('DECLINED_BEFORE_POWER'); // already durable when authorize() returned
    expect(onlyRow().coreEvidenceRef).toMatch(/^core-decision:[0-9a-f-]{36}$/);
    expect(notifier.flush).toHaveBeenCalledTimes(1);
  });

  it('a late acceptance cannot power: the request is fenced while its callout is still in flight', async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = () => resolve(allowed('ALLOWED')); }));
    const pending = build().authorize(authorization(), context(), evse, connector);
    await vi.waitFor(() => expect(store.rows.size).toBe(1));
    // another path (timeout fence) durably declined this exact request first
    expect(await store.markDeclined(onlyRow().id, 'core-decision:fence', new Date())).toBe(true);
    release(); // the 8 s answer arrives after the 3 s decision
    expect(await pending).toBe(AuthorizationStatusEnum.Invalid);
    expect(onlyRow().state).toBe('DECLINED_BEFORE_POWER');
  });

  it('after a decline the same request is fenced: Invalid immediately, no new callout', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const authorizer = build();
    expect(await authorizer.authorize(authorization(), context(), evse, connector)).toBe(AuthorizationStatusEnum.Invalid);
    fetchMock.mockResolvedValue(allowed('ALLOWED')); // the authority would now say yes - it must never be asked
    expect(await authorizer.authorize(authorization(), context(), evse, connector)).toBe(AuthorizationStatusEnum.Invalid);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(1);
  });

  it('a cached acceptance cannot bypass an already declined explicit-target fence', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const authorizer = build(config({ realTimeAuthReplayLastAttempt: true }));
    expect(await authorizer.authorize(authorization(), context(), evse, connector)).toBe(AuthorizationStatusEnum.Invalid);
    const stale = authorization({ realTimeAuthTimeout: 15, realTimeAuthLastAttempt: {
      timestamp: new Date().toISOString(), result: AuthorizationStatusEnum.Accepted, ocppConnectionName: 'CP-001', connectorId: 100,
    } });
    expect(await authorizer.authorize(stale, context(), evse, connector)).toBe(AuthorizationStatusEnum.Invalid);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onlyRow().state).toBe('DECLINED_BEFORE_POWER');
  });

  it('the fence expires: after fenceSeconds a fresh request gets a new ref', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const authorizer = build();
    await authorizer.authorize(authorization(), context(), evse, connector);
    onlyRow().decidedAt = new Date(Date.now() - 31_000);
    expect(await authorizer.authorize(authorization(), context(), evse, connector)).toBe(AuthorizationStatusEnum.Accepted);
    expect(store.rows.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the still-pending ref of the same request on a retry', async () => {
    const begun = await store.begin({ tenantId: 1, ocppConnectionName: 'CP-001', authorizationId: 42, connectorId: 100 }, new Date(), 6000, 30000);
    await build().authorize(authorization(), context(), evse, connector);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).chargingCalloutRef).toBe(begun.ref);
    expect(store.rows.size).toBe(1);
  });

  it.each(['BLOCKED', 'NO_CREDIT', 'NOT_ALLOWED', 'EXPIRED', 'SOMETHING_NEW'])('commits a durable decline for the answer %s', async (answer) => {
    fetchMock.mockResolvedValue(allowed(answer));
    const result = await build().authorize(authorization(), context(), evse, connector);
    expect(result).not.toBe(AuthorizationStatusEnum.Accepted);
    expect(onlyRow().state).toBe('DECLINED_BEFORE_POWER');
  });

  it('a malformed answer is a decline, not an acceptance', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ nope: true }) });
    expect(await build().authorize(authorization(), context(), evse, connector)).not.toBe(AuthorizationStatusEnum.Accepted);
    expect(onlyRow().state).toBe('DECLINED_BEFORE_POWER');
  });

  it('an explicit limited charging target cannot get implicit offline approval on timeout', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    const result = await build().authorize(authorization({ realTimeAuth: AuthorizationWhitelistEnum.AllowedOffline }), context(), evse, connector);
    expect(result).toBe(AuthorizationStatusEnum.Invalid);
    expect(onlyRow().state).toBe('DECLINED_BEFORE_POWER');
    expect(notifier.flush).toHaveBeenCalledTimes(1);
  });

  it('ordinary authorization retains its configured offline behavior when durable charging callouts are disabled', async () => {
    const cfg = config();
    cfg.realTimeAuthChargingCallouts!.enabled = false;
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await build(cfg).authorize(authorization({ realTimeAuth: AuthorizationWhitelistEnum.AllowedOffline }), context(), evse, connector)).toBe(AuthorizationStatusEnum.Accepted);
    expect(store.rows.size).toBe(0);
  });

  it('durable fence storage failure cannot fall back to offline approval', async () => {
    vi.spyOn(store, 'begin').mockRejectedValue(new Error('store unavailable'));
    expect(await build().authorize(authorization({ realTimeAuth: AuthorizationWhitelistEnum.AllowedOffline }), context(), evse, connector)).toBe(AuthorizationStatusEnum.Invalid);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only EXPLICIT targets get a ref: an inferred single connector is not a start target', async () => {
    const singleStation = { locationId: 5, evses: [{ id: 10, connectors: [{ id: 100 }] }] };
    const r = repo();
    r.readChargingStationByStationId.mockResolvedValue(singleStation as never);
    const authorizer = getTestInstance(container, RealTimeAuthorizer, { locationRepository: r, config: config(), chargingCalloutStore: store, declineNotifier: notifier as unknown as ChargingCalloutDeclineNotifier });
    await authorizer.authorize(authorization(), context());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.targetSource).toBe('INFERRED_SINGLE_CONNECTOR');
    expect(body.chargingCalloutRef).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });

  it('is inert when the feature is disabled: no ref, no ledger rows', async () => {
    const cfg = config({ realTimeAuthChargingCallouts: { enabled: false, tenantMap: {} } } as never);
    await build(cfg).authorize(authorization(), context(), evse, connector);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).chargingCalloutRef).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });

  it('still answers declined when the ledger cannot be written (fail closed, no receipt)', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    vi.spyOn(store, 'markDeclined').mockRejectedValue(new Error('db down'));
    const result = await build().authorize(authorization(), context(), evse, connector);
    expect(result).toBe(AuthorizationStatusEnum.Invalid);
    expect(notifier.flush).not.toHaveBeenCalled();
  });

  it('refuses an acceptance it cannot record (ledger unavailable)', async () => {
    vi.spyOn(store, 'markAuthorized').mockRejectedValue(new Error('db down'));
    expect(await build().authorize(authorization(), context(), evse, connector)).toBe(AuthorizationStatusEnum.Invalid);
  });
});
