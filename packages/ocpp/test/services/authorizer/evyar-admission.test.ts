// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { asFunction } from 'awilix';
import { type IMessageContext } from '@citrineos/base';
import {
  AuthorizationStatusEnum as Status,
  AuthorizationWhitelistEnum as Whitelist,
  type AuthorizationDto,
  type ConnectorDto,
  type EvseDto,
  type SystemConfigInput,
} from '@citrineos/types';
import { RealTimeAuthorizer } from '@services/authorizer/real-time-authorizer.js';
import { InMemoryChargingCalloutStore } from '@services/authorizer/ChargingCalloutLedger.js';
import { createTestContainer, getTestInstance } from '@test/test-container.js';
import { aSystemConfig } from '@test/providers/system-config.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const context = (tenantId = 1): IMessageContext => ({
  tenantId,
  ocppConnectionName: 'same-station',
  correlationId: 'request-1',
  timestamp: new Date().toISOString(),
});
const connector: ConnectorDto = {
  id: 100,
  stationId: 7,
  evseId: 10,
  connectorId: 1,
  evseTypeConnectorId: 2,
};
const evse: EvseDto = { id: 10, stationId: 7, evseTypeId: 1, connectors: [connector] };
const auth = (overrides: Partial<AuthorizationDto> = {}): AuthorizationDto => ({
  id: 42,
  idToken: 'AABBCC',
  idTokenType: 'ISO14443',
  status: Status.Accepted,
  tenantPartnerId: null,
  realTimeAuth: Whitelist.Never,
  realTimeAuthUrl: 'http://adapter.test/authorize',
  ...overrides,
});
const instances: RealTimeAuthorizer[] = [];
function build(
  overrides: Partial<SystemConfigInput> = {},
  store = new InMemoryChargingCalloutStore(),
) {
  const { container } = createTestContainer();
  const update = vi.fn().mockResolvedValue(undefined);
  const read = vi.fn().mockResolvedValue({
    id: 7,
    ocppConnectionName: 'same-station',
    isOnline: true,
    locationId: 9,
    evses: [evse],
  });
  const authorizer = getTestInstance(container, RealTimeAuthorizer, {
    config: aSystemConfig({ realTimeAuthChargingCallouts: { enabled: true }, ...overrides }),
    chargingStationRepository: { readChargingStationByOcppConnectionName: read },
    authorizationRepository: { updateByKey: update },
    chargingCalloutStore: store,
  });
  instances.push(authorizer);
  return { authorizer, store, update, read };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fetchResponse(allowed = 'ALLOWED') {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ timestamp: new Date().toISOString(), data: { allowed } }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('EVYAR mandatory admission boundary', () => {
  it('fails construction when enabled store is absent', () => {
    const { container } = createTestContainer();
    expect(() =>
      getTestInstance(container, RealTimeAuthorizer, {
        config: aSystemConfig({ realTimeAuthChargingCallouts: { enabled: true } }),
        chargingStationRepository: {},
        authorizationRepository: {},
      }),
    ).toThrow();
  });
  it('does not suppress a store resolution error when enabled', () => {
    const { container } = createTestContainer();
    const resolutionError = new Error('store construction failed');
    container.register({
      chargingCalloutStore: asFunction(() => {
        throw resolutionError;
      }),
    });
    expect(() =>
      getTestInstance(container, RealTimeAuthorizer, {
        config: aSystemConfig({ realTimeAuthChargingCallouts: { enabled: true } }),
        chargingStationRepository: {},
        authorizationRepository: {},
      }),
    ).toThrow('store construction failed');
  });
  it('pins an explicit target and keeps OCPP identifiers separate from database IDs', async () => {
    const mock = fetchResponse();
    const { authorizer, store, read, update } = build();
    const a = auth();
    expect(await authorizer.authorize(a, context(), evse, connector)).toBe(Status.Accepted);
    expect(read).toHaveBeenCalledWith(1, 'same-station');
    expect(update).toHaveBeenCalledWith(1, a, '42');
    const init = mock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      evseId: 10,
      connectorId: 100,
      ocppEvseId: 1,
      ocppConnectorId: 2,
      targetSource: 'EXPLICIT',
      tenantPartnerId: null,
    });
    expect(typeof body.chargingCalloutRef).toBe('string');
    expect(await store.get(body.chargingCalloutRef)).toMatchObject({
      tenantId: 1,
      state: 'AUTHORIZED',
    });
    expect(new Headers(init?.headers).get('x-evyar-request-budget-ms')).toMatch(/^[1-9]\d*$/);
  });
  it('never replays a recent Authorize decision for an explicit start', async () => {
    const mock = fetchResponse('NO_CREDIT');
    const { authorizer } = build();
    const a = auth({
      realTimeAuthLastAttempt: {
        timestamp: new Date().toISOString(),
        result: Status.Accepted,
        ocppConnectionName: 'same-station',
        connectorId: 100,
      },
    });
    expect(await authorizer.authorize(a, context(), evse, connector)).toBe(Status.NoCredit);
    expect(mock).toHaveBeenCalledOnce();
    expect(await authorizer.authorize(a, context(), evse, connector)).toBe(Status.Invalid);
    expect(mock).toHaveBeenCalledOnce();
  });
  it('keeps same-name station fences isolated by tenant', async () => {
    const mock = fetchResponse('BLOCKED');
    const { authorizer, store } = build();
    expect(await authorizer.authorize(auth(), context(1), evse, connector)).toBe(Status.Blocked);
    mock.mockResolvedValueOnce(Response.json({ data: { allowed: 'ALLOWED' } }));
    expect(await authorizer.authorize(auth(), context(2), evse, connector)).toBe(Status.Accepted);
    expect([...store.rows.values()].map((r) => [r.tenantId, r.state])).toEqual([
      [1, 'DECLINED_BEFORE_POWER'],
      [2, 'AUTHORIZED'],
    ]);
  });
  it('does not claim an inferred single connector is an explicit power target', async () => {
    const mock = fetchResponse();
    const { authorizer, store } = build();
    expect(await authorizer.authorize(auth(), context())).toBe(Status.Accepted);
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toMatchObject({
      targetSource: 'INFERRED_SINGLE_CONNECTOR',
    });
    expect(store.rows.size).toBe(0);
  });
  it('keeps unresolved explicit targets failed closed despite AllowedOffline', async () => {
    const mock = fetchResponse();
    const { authorizer } = build();
    expect(
      await authorizer.authorize(auth({ realTimeAuth: Whitelist.AllowedOffline }), context(), {
        ...evse,
        connectors: [],
      }),
    ).toBe(Status.Invalid);
    expect(mock).not.toHaveBeenCalled();
  });
  it('does not turn an unresolved named start into an inferred single-connector authorization', async () => {
    const mock = fetchResponse();
    const { authorizer } = build();
    expect(
      await authorizer.authorize(auth({ realTimeAuth: Whitelist.AllowedOffline }), {
        ...context(),
        requiresExplicitAuthorizationTarget: true,
      }),
    ).toBe(Status.Invalid);
    expect(mock).not.toHaveBeenCalled();
  });
  it('does not accept power when durable authorization decision fails', async () => {
    fetchResponse();
    const { authorizer, store } = build();
    vi.spyOn(store, 'markAuthorized').mockRejectedValueOnce(new Error('database unavailable'));
    expect(await authorizer.authorize(auth(), context(), evse, connector)).toBe(Status.Invalid);
  });
  it('bounds a stalled fetch and fences a late approval', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(25));
    let finish: (response: Response) => void = () => {
      throw new Error('fetch not entered');
    };
    const mock = vi.fn<typeof fetch>().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', mock);
    const { authorizer, store } = build({ realTimeAuthRequestTimeoutMs: 100 });
    expect(await authorizer.authorize(auth(), context(), evse, connector)).toBe(Status.Invalid);
    finish(Response.json({ data: { allowed: 'ALLOWED' } }));
    expect([...store.rows.values()][0]).toMatchObject({ state: 'DECLINED_BEFORE_POWER' });
    expect(await authorizer.authorize(auth(), context(), evse, connector)).toBe(Status.Invalid);
    expect(mock).toHaveBeenCalledOnce();
  });
  it('bounds a stalled JSON body under the same request deadline', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(25));
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      }),
    );
    const mock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', mock);
    const { authorizer, store } = build({ realTimeAuthRequestTimeoutMs: 100 });
    expect(await authorizer.authorize(auth(), context(), evse, connector)).toBe(Status.Invalid);
    bodyController?.enqueue(
      new TextEncoder().encode(JSON.stringify({ data: { allowed: 'ALLOWED' } })),
    );
    bodyController?.close();
    expect([...store.rows.values()][0]).toMatchObject({ state: 'DECLINED_BEFORE_POWER' });
    expect(await authorizer.authorize(auth(), context(), evse, connector)).toBe(Status.Invalid);
    expect(mock).toHaveBeenCalledOnce();
  });
});
