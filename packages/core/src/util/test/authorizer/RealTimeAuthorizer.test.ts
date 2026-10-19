// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
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
import { createTestContainer, getTestInstance } from '../../../test/testContainer.js';

function buildMockLocationRepository(chargingStation: unknown): Mocked<ILocationRepository> {
  return {
    readChargingStationByStationId: vi.fn().mockResolvedValue(chargingStation),
  } as unknown as Mocked<ILocationRepository>;
}

function buildAuthorization(): Authorization {
  return {
    id: 42,
    realTimeAuthUrl: 'http://realtime-auth.test/check',
    realTimeAuth: AuthorizationWhitelistEnum.Never,
    status: AuthorizationStatusEnum.Accepted,
    tenantPartnerId: 7,
    idToken: 'F00B4C',
    idTokenType: 'ISO14443',
    realTimeAuthLastAttempt: undefined,
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as Authorization;
}

function buildContext(): IMessageContext {
  return {
    tenantId: 1,
    ocppConnectionName: 'CP-001',
    correlationId: 'cid',
    timestamp: new Date().toISOString(),
  } as IMessageContext;
}

const evse = { id: 10 } as EvseDto;
const connector = { id: 100 } as ConnectorDto;

describe('RealTimeAuthorizer', () => {
  const { container } = createTestContainer();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        timestamp: new Date().toISOString(),
        data: { allowed: 'ALLOWED' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('does not throw when ChargingStation has no Location (locationId is null)', async () => {
    const chargingStation = { locationId: null, evses: [] };
    const repo = buildMockLocationRepository(chargingStation);
    const authorizer = getTestInstance(container, RealTimeAuthorizer, {
      locationRepository: repo,
      config: {} as SystemConfig,
    });

    const result = await authorizer.authorize(
      buildAuthorization(),
      buildContext(),
      evse,
      connector,
    );

    expect(result).toBe(AuthorizationStatusEnum.Accepted);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('locationId');
  });

  it('calls realtime authorization at station scope when EVSE and connector are unknown', async () => {
    const repo = buildMockLocationRepository({ locationId: 12, evses: [{ id: 1 }, { id: 2 }] });
    const authorizer = getTestInstance(container, RealTimeAuthorizer, {
      locationRepository: repo,
      config: {} as SystemConfig,
    });
    const authorization = buildAuthorization();
    authorization.tenantPartnerId = null;

    const result = await authorizer.authorize(authorization, buildContext());

    expect(result).toBe(AuthorizationStatusEnum.Accepted);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      tenantPartnerId: null,
      ocppConnectionName: 'CP-001',
      idToken: 'F00B4C',
    });
    expect(body).not.toHaveProperty('evseId');
    expect(body).not.toHaveProperty('connectorId');
  });

  it('fails closed on a malformed realtime authorization response', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ timestamp: 'now' }) });
    const authorizer = getTestInstance(container, RealTimeAuthorizer, {
      locationRepository: buildMockLocationRepository({ locationId: null, evses: [] }),
      config: {} as SystemConfig,
    });

    await expect(
      authorizer.authorize(buildAuthorization(), buildContext(), evse, connector),
    ).resolves.toBe(AuthorizationStatusEnum.Unknown);
  });

  describe('start target evidence and bounded callout (CGP-0012/0013)', () => {
    const named = { id: 10, evseTypeId: 2, connectors: [{ id: 100, connectorId: 3 }] } as unknown as EvseDto;
    const namedConnector = { id: 100, connectorId: 3 } as unknown as ConnectorDto;
    const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body);
    const make = (station: unknown, config: Partial<SystemConfig> = {}) =>
      getTestInstance(container, RealTimeAuthorizer, {
        locationRepository: buildMockLocationRepository(station),
        config: config as SystemConfig,
      });

    it('marks an EVSE/connector named by the message as EXPLICIT and carries the OCPP identifiers', async () => {
      await make({ locationId: 1, evses: [] }).authorize(buildAuthorization(), buildContext(), named, namedConnector);
      expect(bodyOf()).toMatchObject({ evseId: 10, connectorId: 100, targetSource: 'EXPLICIT', ocppEvseId: 2, ocppConnectorId: 3 });
    });

    it('marks a single-connector guess on a bare Authorize as INFERRED, never EXPLICIT', async () => {
      await make({ locationId: 1, evses: [{ id: 7, connectors: [{ id: 70 }] }] }).authorize(buildAuthorization(), buildContext());
      const body = bodyOf();
      expect(body).toMatchObject({ evseId: 7, connectorId: 70, targetSource: 'INFERRED_SINGLE_CONNECTOR' });
      expect(body).not.toHaveProperty('ocppConnectorId');
    });

    it('marks an unknown target as NONE', async () => {
      await make({ locationId: 1, evses: [{ id: 1 }, { id: 2 }] }).authorize(buildAuthorization(), buildContext());
      expect(bodyOf()).toMatchObject({ targetSource: 'NONE' });
    });

    it('bounds the callout with an abort signal and fails closed when it fires', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      const result = await make({ locationId: 1, evses: [] }, { realTimeAuthRequestTimeoutMs: 250 }).authorize(
        buildAuthorization(), buildContext(), named, namedConnector,
      );
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(result).toBe(AuthorizationStatusEnum.Invalid);
    });

    describe('replay of the previous real-time answer', () => {
      const recent = (): Authorization => {
        const a = buildAuthorization();
        (a as unknown as { realTimeAuthLastAttempt: unknown }).realTimeAuthLastAttempt = {
          timestamp: new Date().toISOString(),
          result: AuthorizationStatusEnum.Accepted,
          ocppConnectionName: 'CP-001',
          evseId: 10,
          connectorId: 100,
        };
        return a;
      };
      const flat = { id: 10, connectors: [{ id: 100 }] } as unknown as EvseDto;
      const flatConnector = { id: 100 } as unknown as ConnectorDto;

      it('still replays by default (compatible behaviour)', async () => {
        await make({ locationId: 1, evses: [] }, { realTimeAuthDefaultTimeoutSeconds: 15 }).authorize(
          recent(), buildContext(), flat, flatConnector,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('makes the callout every time when replay is disabled', async () => {
        await make({ locationId: 1, evses: [] }, { realTimeAuthDefaultTimeoutSeconds: 15, realTimeAuthReplayLastAttempt: false }).authorize(
          recent(), buildContext(), flat, flatConnector,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });
  });
});
