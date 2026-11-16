// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { type IAuthorizer, type IMessage, type IMessageContext } from '@citrineos/base';
import {
  AuthorizationStatusEnum,
  AuthorizationWhitelistEnum,
  type AuthorizationDto,
  type ChargingAdmissionProvenance,
  OCPP1_6,
  OCPP2_0_1,
  OCPPVersion,
  type SystemConfig,
} from '@citrineos/types';
import { StartTransactionRequestOcpp16Handler } from '@handlers/requests/1.6/start-transaction-request-ocpp-16-handler.js';
import { TransactionEventRequestOcpp2Handler } from '@handlers/requests/2/transaction-event-request-ocpp-2-handler.js';
import { TransactionService } from '@modules/transactions/transaction-service.js';
import { RealTimeAuthorizer } from '@services/authorizer/real-time-authorizer.js';
import { createTestContainer, makeMockOcppSender, mockDeps } from '@test/test-container.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ref = '2a43d152-c973-4336-8867-e9c39fc80731';
const injected: ChargingAdmissionProvenance = {
  schemaVersion: '1.0.0', chargingCalloutRef: 'transport-forgery',
  nativeRequestId: 'forged', nativeRequestHash: '0'.repeat(64),
};
const timestamp = '2026-11-16T00:00:00.000Z';

function context(): IMessageContext {
  return {
    tenantId: 1, ocppConnectionName: 'CP-admission', correlationId: 'native-rpc-123', timestamp,
    nativeAdmissionRequest: { id: 'transport-forgery', hash: '0'.repeat(64) },
    chargingAdmissionProvenance: { ...injected },
  };
}

function setup(protocol: OCPPVersion, authorizers: IAuthorizer[] = []) {
  const { logger } = createTestContainer();
  const config = {
    realTimeAuthRequestTimeoutMs: 8000,
    realTimeAuthChargingCallouts: { enabled: true, fenceSeconds: 60 },
    timeouts: { realTimeAuthDefaultTimeoutSeconds: 15 },
    transactions: {},
  } as SystemConfig;
  const authorization = {
    id: 42, tenantId: 1, idToken: 'F00B4C', idTokenType: 'ISO14443',
    status: AuthorizationStatusEnum.Accepted, concurrentTransaction: true,
    realTimeAuthUrl: 'https://admission.test/check', realTimeAuth: AuthorizationWhitelistEnum.Never,
  } as AuthorizationDto;
  const evse = { id: 10, evseTypeId: 3 };
  const connector = { id: 100, connectorId: 2, evseTypeConnectorId: 1, evseId: 10, evse };
  const authorizationRepository = {
    readAllByQuerystring: vi.fn().mockResolvedValue([authorization]),
    updateByKey: vi.fn().mockResolvedValue(undefined),
  };
  const connectorRepository = {
    readConnectorByStationIdAndOcpp16ConnectorId: vi.fn().mockResolvedValue(connector),
    readConnectorByStationIdAndOcpp201EvseType: vi.fn().mockResolvedValue(connector),
  };
  const transactionRepository = {
    createTransactionByStartTransaction: vi.fn().mockResolvedValue({ id: 8, transactionId: '6' }),
    createOrUpdateTransactionByTransactionEventAndStationId: vi.fn().mockResolvedValue({
      id: 8, transactionId: 'native-6', isActive: true,
    }),
    deactivateActiveTransactionsByStationIdAndEvseId: vi.fn().mockResolvedValue([]),
    readTransactionByStationIdAndTransactionId: vi.fn().mockResolvedValue(undefined),
  };
  const store = {
    begin: vi.fn().mockResolvedValue({ kind: 'CALLOUT', ref }),
    markAuthorized: vi.fn().mockResolvedValue(true),
    markDeclined: vi.fn().mockResolvedValue(true),
  };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ data: { allowed: 'ALLOWED' } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const realTimeAuthorizer = new RealTimeAuthorizer(mockDeps<typeof RealTimeAuthorizer>({
    logger, config, authorizationRepository,
    chargingStationRepository: {
      readChargingStationByOcppConnectionName: vi.fn().mockResolvedValue({ protocol, evses: [] }),
    },
    chargingCalloutStore: store,
    declineNotifier: { start: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) },
  }));
  const service = new TransactionService(mockDeps<typeof TransactionService>({
    logger, realTimeAuthorizer, authorizers, authorizationRepository, connectorRepository,
    transactionRepository,
    evseRepository: { readEvseByStationIdAndOcpp201EvseId: vi.fn().mockResolvedValue(evse) },
  }));
  const ocppSender = makeMockOcppSender();
  const handler16 = new StartTransactionRequestOcpp16Handler(mockDeps<typeof StartTransactionRequestOcpp16Handler>({
    logger, ocppSender, connectorRepository, transactionRepository, transactionService: service,
  }));
  const handler2 = new TransactionEventRequestOcpp2Handler(mockDeps<typeof TransactionEventRequestOcpp2Handler>({
    logger, ocppSender, config, transactionRepository, transactionService: service,
    transactionEventRepository: { readAllByStationIdAndTransactionId: vi.fn().mockResolvedValue([]) },
    variableAttributeRepository: { readAllByQuerystring: vi.fn().mockResolvedValue([]) },
  }));
  return { authorization, store, fetchMock, service, realTimeAuthorizer, handler16, handler2,
    connectorRepository, transactionRepository, ocppSender };
}

function start16(): IMessage<OCPP1_6.StartTransactionRequest> {
  return {
    protocol: OCPPVersion.OCPP1_6, context: context(),
    payload: { timestamp, meterStart: 0, idTag: 'F00B4C', connectorId: 2 },
  } as IMessage<OCPP1_6.StartTransactionRequest>;
}
function start2(protocol = OCPPVersion.OCPP2_0_1): IMessage<OCPP2_0_1.TransactionEventRequest> {
  return {
    protocol, context: context(), payload: {
      triggerReason: OCPP2_0_1.TriggerReasonEnumType.Authorized,
      transactionInfo: { transactionId: 'native-6' }, timestamp, seqNo: 0,
      idToken: { type: OCPP2_0_1.IdTokenEnumType.ISO14443, idToken: 'F00B4C' },
      evse: { id: 3, connectorId: 1 }, eventType: OCPP2_0_1.TransactionEventEnumType.Started,
    },
  } as IMessage<OCPP2_0_1.TransactionEventRequest>;
}

const expected16 = createHash('sha256').update('{"connectorId":2,"idTag":"F00B4C","meterStart":0,"timestamp":"2026-11-16T00:00:00.000Z"}').digest('hex');
const expected2 = createHash('sha256').update('{"eventType":"Started","evse":{"connectorId":1,"id":3},"idToken":{"idToken":"F00B4C","type":"ISO14443"},"seqNo":0,"timestamp":"2026-11-16T00:00:00.000Z","transactionInfo":{"transactionId":"native-6"},"triggerReason":"Authorized"}').digest('hex');
function expected(hash: string): ChargingAdmissionProvenance {
  return { schemaVersion: '1.0.0', chargingCalloutRef: ref,
    nativeRequestId: 'native-rpc-123', nativeRequestHash: hash };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('native Start admission provenance through real authorizer, service and handlers', () => {
  it('waits for durable acceptance and forwards the original canonical 1.6 RPC binding', async () => {
    const f = setup(OCPPVersion.OCPP1_6);
    // The workspace targets ES2022, before Promise.withResolvers.
    let commit!: (value: boolean) => void;
    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    f.store.markAuthorized.mockImplementation(() => {
      markReached();
      return new Promise<boolean>((resolve) => { commit = resolve; });
    });
    const message = start16();
    const original = JSON.stringify(message.payload);
    const handling = f.handler16.handle(message);
    await reached;
    expect(f.transactionRepository.createTransactionByStartTransaction).not.toHaveBeenCalled();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    commit(true);
    await handling;
    expect(f.transactionRepository.createTransactionByStartTransaction).toHaveBeenCalledWith(
      1, message.payload, 'CP-admission', expected(expected16),
    );
    expect(JSON.stringify(message.payload)).toBe(original);
    const payload = JSON.parse(f.fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ chargingCalloutRef: ref, ocppEvseId: 2, ocppConnectorId: 2 });
    expect(f.ocppSender.sendCallResultWithMessage.mock.calls[0][1]).toMatchObject({
      transactionId: 6, idTagInfo: { status: 'Accepted' },
    });
  });

  it('keeps interleaved same-credential Starts bound to their own target, callout and native RPC', async () => {
    const f = setup(OCPPVersion.OCPP1_6);
    const secondRef = '774a5d23-b1db-472f-ac8c-e082123649bc';
    f.connectorRepository.readConnectorByStationIdAndOcpp16ConnectorId.mockImplementation(
      async (_tenantId: number, _station: string, connectorId: number) => ({
        id: connectorId === 2 ? 100 : 101,
        connectorId,
        evseId: connectorId === 2 ? 10 : 11,
        evse: { id: connectorId === 2 ? 10 : 11, evseTypeId: connectorId },
      }),
    );
    f.store.begin.mockImplementation(async (key: { connectorId: number }) => ({
      kind: 'CALLOUT', ref: key.connectorId === 100 ? ref : secondRef,
    }));
    const allowedResponse = { ok: true, json: async () => ({ data: { allowed: 'ALLOWED' } }) };
    const responses = new Map<string, (response: typeof allowedResponse) => void>();
    let markBothSent!: () => void;
    // ES2022 does not provide Promise.withResolvers.
    const bothSent = new Promise<void>((resolve) => { markBothSent = resolve; });
    f.fetchMock.mockImplementation((_url: string, options: { body: string }) => {
      const payload = JSON.parse(options.body);
      return new Promise<typeof allowedResponse>((resolve) => {
        responses.set(payload.chargingCalloutRef, resolve);
        if (responses.size === 2) markBothSent();
      });
    });

    const first = start16();
    first.context.correlationId = 'native-rpc-first';
    const second = start16();
    second.context.correlationId = 'native-rpc-second';
    second.payload.connectorId = 3;
    second.payload.meterStart = 17;
    const secondHash = createHash('sha256').update('{"connectorId":3,"idTag":"F00B4C","meterStart":17,"timestamp":"2026-11-16T00:00:00.000Z"}').digest('hex');
    const firstHandling = f.handler16.handle(first);
    const secondHandling = f.handler16.handle(second);
    await bothSent;
    expect(first.context).not.toBe(second.context);
    expect(first.context.nativeAdmissionRequest).not.toBe(second.context.nativeAdmissionRequest);
    expect(f.transactionRepository.createTransactionByStartTransaction).not.toHaveBeenCalled();

    // Complete the second request first, while the first still waits on its HTTP response.
    responses.get(secondRef)!(allowedResponse);
    try {
      await secondHandling;
      expect(first.context.chargingAdmissionProvenance).toBeUndefined();
      expect(f.transactionRepository.createTransactionByStartTransaction).toHaveBeenCalledExactlyOnceWith(
        1, second.payload, 'CP-admission', {
          schemaVersion: '1.0.0', chargingCalloutRef: secondRef,
          nativeRequestId: 'native-rpc-second', nativeRequestHash: secondHash,
        },
      );
      expect(f.store.markAuthorized.mock.calls.map(([calloutRef]) => calloutRef)).toEqual([secondRef]);
    } finally {
      responses.get(ref)!(allowedResponse);
      await firstHandling;
    }

    expect(f.transactionRepository.createTransactionByStartTransaction).toHaveBeenNthCalledWith(
      2, 1, first.payload, 'CP-admission', {
        schemaVersion: '1.0.0', chargingCalloutRef: ref,
        nativeRequestId: 'native-rpc-first', nativeRequestHash: expected16,
      },
    );
    expect(second.context.chargingAdmissionProvenance).toEqual({
      schemaVersion: '1.0.0', chargingCalloutRef: secondRef,
      nativeRequestId: 'native-rpc-second', nativeRequestHash: secondHash,
    });
    expect(f.store.begin.mock.calls.map(([key]) => key)).toEqual([
      { tenantId: 1, ocppConnectionName: 'CP-admission', authorizationId: 42, connectorId: 100 },
      { tenantId: 1, ocppConnectionName: 'CP-admission', authorizationId: 42, connectorId: 101 },
    ]);
    expect(f.fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      expect.objectContaining({ idToken: 'F00B4C', chargingCalloutRef: ref, ocppConnectorId: 2 }),
      expect.objectContaining({ idToken: 'F00B4C', chargingCalloutRef: secondRef, ocppConnectorId: 3 }),
    ]);
  });

  it('returns Invalid and clears the grant when native transaction creation rejects duplicate consumption', async () => {
    const f = setup(OCPPVersion.OCPP1_6);
    f.transactionRepository.createTransactionByStartTransaction.mockRejectedValue(new Error('callout already consumed'));
    const message = start16();
    await f.handler16.handle(message);
    expect(f.store.markAuthorized).toHaveBeenCalled();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.ocppSender.sendCallResultWithMessage.mock.calls[0][1].idTagInfo.status).toBe('Invalid');
  });

  it.each([OCPPVersion.OCPP2_0_1, OCPPVersion.OCPP2_1])('forwards canonical nested Started payload binding for %s', async (protocol) => {
    const f = setup(protocol);
    const message = start2(protocol);
    const original = JSON.stringify(message.payload);
    await f.handler2.handle(message);
    expect(f.transactionRepository.createOrUpdateTransactionByTransactionEventAndStationId).toHaveBeenCalledWith(
      1, message.payload, 'CP-admission', expected(expected2),
    );
    expect(JSON.stringify(message.payload)).toBe(original);
    expect(JSON.parse(f.fetchMock.mock.calls[0][1].body)).toMatchObject({
      chargingCalloutRef: ref, ocppEvseId: 3, ocppConnectorId: 1,
    });
  });

  it('removes a committed grant when a later authorizer denies 1.6 Start', async () => {
    const deny = { authorize: vi.fn().mockResolvedValue(AuthorizationStatusEnum.Blocked) };
    const f = setup(OCPPVersion.OCPP1_6, [deny]);
    const message = start16();
    await f.handler16.handle(message);
    expect(f.store.markAuthorized).toHaveBeenCalledWith(ref, expect.any(Date));
    expect(deny.authorize).toHaveBeenCalled();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.transactionRepository.createTransactionByStartTransaction).not.toHaveBeenCalled();
    expect(f.ocppSender.sendCallResultWithMessage.mock.calls[0][1].idTagInfo.status).toBe('Blocked');
  });

  it.each([OCPPVersion.OCPP2_0_1, OCPPVersion.OCPP2_1])('does not smuggle accepted provenance into rejected %s transaction history', async (protocol) => {
    const f = setup(protocol, [{ authorize: vi.fn().mockResolvedValue(AuthorizationStatusEnum.Blocked) }]);
    const message = start2(protocol);
    await f.handler2.handle(message);
    expect(f.store.markAuthorized).toHaveBeenCalled();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.transactionRepository.createOrUpdateTransactionByTransactionEventAndStationId).toHaveBeenCalledWith(
      1, message.payload, 'CP-admission', undefined,
    );
    expect(f.ocppSender.sendCallResultWithMessage.mock.calls[0][1].idTokenInfo.status).toBe('Blocked');
  });

  it('clears provenance when 2.1 prepaid policy rejects after real-time acceptance', async () => {
    const f = setup(OCPPVersion.OCPP2_1);
    Object.assign(f.authorization, { isPrepaid: true, prepaidBalance: 0 });
    const message = start2(OCPPVersion.OCPP2_1);
    await f.handler2.handle(message);
    expect(f.store.markAuthorized).toHaveBeenCalled();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.ocppSender.sendCallResultWithMessage.mock.calls[0][1].idTokenInfo.status).toBe('NoCredit');
  });

  it('cannot power a late acceptance whose durable decision is withdrawn or otherwise refused', async () => {
    const f = setup(OCPPVersion.OCPP1_6);
    f.store.markAuthorized.mockResolvedValue(false);
    const message = start16();
    await f.handler16.handle(message);
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.transactionRepository.createTransactionByStartTransaction).not.toHaveBeenCalled();
    expect(f.ocppSender.sendCallResultWithMessage.mock.calls[0][1].idTagInfo.status).toBe('Invalid');
  });

  it('removes provenance if a later authorizer throws', async () => {
    const f = setup(OCPPVersion.OCPP1_6, [{ authorize: vi.fn().mockRejectedValue(new Error('policy unavailable')) }]);
    const message = start16();
    await f.handler16.handle(message);
    expect(f.store.markAuthorized).toHaveBeenCalled();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.transactionRepository.createTransactionByStartTransaction).not.toHaveBeenCalled();
  });

  it('does not create Start provenance for Updated events despite injected context', async () => {
    const f = setup(OCPPVersion.OCPP2_0_1);
    const message = start2();
    message.payload.eventType = OCPP2_0_1.TransactionEventEnumType.Updated;
    await f.handler2.handle(message);
    expect(message.context.nativeAdmissionRequest).toBeUndefined();
    expect(message.context.chargingAdmissionProvenance).toBeUndefined();
    expect(f.transactionRepository.createOrUpdateTransactionByTransactionEventAndStationId).toHaveBeenCalledWith(
      1, message.payload, 'CP-admission', undefined,
    );
  });

  it.each(['whitelist', 'no-url', 'cache'] as const)('does not fabricate provenance from %s acceptance', async (mode) => {
    const f = setup(OCPPVersion.OCPP1_6);
    const ctx = context();
    if (mode === 'whitelist') f.authorization.realTimeAuth = AuthorizationWhitelistEnum.Allowed;
    if (mode === 'no-url') f.authorization.realTimeAuthUrl = undefined;
    if (mode === 'cache') f.authorization.realTimeAuthLastAttempt = {
      timestamp: new Date().toISOString(), ocppConnectionName: ctx.ocppConnectionName,
      result: AuthorizationStatusEnum.Accepted,
    };
    expect(await f.realTimeAuthorizer.authorize(f.authorization, ctx)).toBe(AuthorizationStatusEnum.Accepted);
    expect(ctx.chargingAdmissionProvenance).toBeUndefined();
    expect(f.store.markAuthorized).not.toHaveBeenCalled();
  });
});
