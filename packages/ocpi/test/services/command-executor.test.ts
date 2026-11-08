// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { OCPPVersion } from '@citrineos/types';
import { Logger } from 'tslog';
import { describe, expect, it, vi } from 'vitest';

import { ocpiConfigSchema } from '@ocpi/config/ocpi-types.js';
import { GET_TENANT_PARTNER_BY_ID } from '@ocpi/transport/graphql/index.js';
import { CommandResultType } from '@ocpi/types/command-result.js';
import { CommandType } from '@ocpi/types/command-type.js';
import { CommandExecutor } from '@ocpi/services/command-executor.js';
import {
  COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
  COMMAND_RESPONSE_URL_CACHE_RESOLVED,
} from '@ocpi/util/consts.js';

const TIMEOUT = 42;
const RESPONSE_URL = 'https://emsp.test/commands/START_SESSION/1';

// The executor reads only commands.timeout; the rest is the minimum the schema accepts.
const CONFIG = ocpiConfigSchema.parse({
  env: 'development',
  ocpiServer: { host: '0.0.0.0', port: 8085 },
  ocpiModules: {},
  database: { host: 'localhost', port: 5432, database: 'ocpi', username: 'ocpi', password: '' },
  cache: { memory: true },
  graphql: { endpoint: 'http://localhost:8090/v1/graphql' },
  commands: {
    timeout: TIMEOUT,
    ocpiBaseUrl: 'http://localhost:8085/ocpi',
    ocpp1_6: {
      remoteStartTransactionRequestUrl: 'http://core/ocpp/1.6/remoteStart',
      remoteStopTransactionRequestUrl: 'http://core/ocpp/1.6/remoteStop',
      unlockConnectorRequestUrl: 'http://core/ocpp/1.6/unlock',
    },
    ocpp2_0_1: {
      requestStartTransactionRequestUrl: 'http://core/ocpp/2.0.1/requestStart',
      requestStopTransactionRequestUrl: 'http://core/ocpp/2.0.1/requestStop',
      unlockConnectorRequestUrl: 'http://core/ocpp/2.0.1/unlock',
    },
    ocpp2_1: {
      requestStartTransactionRequestUrl: 'http://core/ocpp/2.1/requestStart',
      requestStopTransactionRequestUrl: 'http://core/ocpp/2.1/requestStop',
      unlockConnectorRequestUrl: 'http://core/ocpp/2.1/unlock',
    },
  },
  logLevel: 6,
  defaultPageLimit: 50,
  maxPageLimit: 1000,
});

const partnerData = { id: 11, tenantId: 7, countryCode: 'GB', partyId: 'MSP' };
const PARTNER = partnerData as never;
const FAILED_MESSAGE = { language: 'en', text: 'Charging station communication failed' };

const aStation = (protocol: OCPPVersion | null) => ({ id: 5, protocol }) as never;
const aStartSession = () => ({ response_url: RESPONSE_URL, token: { uid: 'TOK1' } }) as never;
const aStopSession = () => ({ response_url: RESPONSE_URL, session_id: 'S1' }) as never;
const anUnlockConnector = () =>
  ({ response_url: RESPONSE_URL, location_id: '7', evse_uid: 'cs-001::1' }) as never;

function aHandler(version: OCPPVersion) {
  return {
    supportedVersion: version,
    sendStartSessionCommand: vi.fn().mockResolvedValue(undefined),
    sendStopSessionCommand: vi.fn().mockResolvedValue(undefined),
    sendUnlockConnectorCommand: vi.fn().mockResolvedValue(undefined),
    handleAsyncCommandResponse: vi.fn().mockResolvedValue(undefined),
  };
}

// Registry gets a 1.6 and a 2.0.1 handler; 2.1 is deliberately left uncovered.
function anExecutor(include21 = false) {
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(true),
    onChange: vi.fn().mockResolvedValue(COMMAND_RESPONSE_URL_CACHE_RESOLVED),
  };
  const request = vi.fn();
  const postCommandResult = vi.fn().mockResolvedValue(undefined);
  const handler16 = aHandler(OCPPVersion.OCPP1_6);
  const handler201 = aHandler(OCPPVersion.OCPP2_0_1);
  const handler21 = aHandler(OCPPVersion.OCPP2_1);
  const executor = new CommandExecutor({
    config: CONFIG,
    logger: new Logger({ type: 'hidden' }),
    ocpiGraphqlClient: { request } as never,
    commandsClientApi: { postCommandResult } as never,
    cacheWrapper: { cache } as never,
    handlers: [handler16, handler201, ...(include21 ? [handler21] : [])] as never,
  });
  return { executor, cache, request, postCommandResult, handler16, handler201, handler21 };
}

const flushCallbacks = () => new Promise((resolve) => setImmediate(resolve));

describe('CommandExecutor command dispatch', () => {
  it('StartSession on a 1.6 station goes to the 1.6 handler', async () => {
    const { executor, handler16, handler201, postCommandResult } = anExecutor();
    const startSession = aStartSession();
    const station = aStation(OCPPVersion.OCPP1_6);

    await executor.executeStartSession(startSession, PARTNER, station);

    expect(handler16.sendStartSessionCommand).toHaveBeenCalledOnce();
    const [session, partner, passedStation, commandId] =
      handler16.sendStartSessionCommand.mock.calls[0];
    expect(session).toBe(startSession);
    expect(partner).toBe(PARTNER);
    expect(passedStation).toBe(station);
    expect(commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(handler201.sendStartSessionCommand).not.toHaveBeenCalled();
    expect(postCommandResult).not.toHaveBeenCalled();
  });

  it('StopSession on a 2.0.1 station goes to the 2.0.1 handler', async () => {
    const { executor, handler16, handler201 } = anExecutor();
    const stopSession = aStopSession();
    const station = aStation(OCPPVersion.OCPP2_0_1);

    await executor.executeStopSession(stopSession, PARTNER, station);

    expect(handler201.sendStopSessionCommand).toHaveBeenCalledOnce();
    expect(handler201.sendStopSessionCommand.mock.calls[0].slice(0, 3)).toEqual([
      stopSession,
      PARTNER,
      station,
    ]);
    expect(handler16.sendStopSessionCommand).not.toHaveBeenCalled();
  });

  it('UnlockConnector reaches the matching handler with the station', async () => {
    const { executor, handler16 } = anExecutor();
    const unlock = anUnlockConnector();
    const station = aStation(OCPPVersion.OCPP1_6);

    await executor.executeUnlockConnector(unlock, PARTNER, station);

    expect(handler16.sendUnlockConnectorCommand).toHaveBeenCalledOnce();
    expect(handler16.sendUnlockConnectorCommand.mock.calls[0].slice(0, 3)).toEqual([
      unlock,
      PARTNER,
      station,
    ]);
  });

  it('the commandId handed to the handler is the cache key for the response url', async () => {
    const { executor, cache, handler16 } = anExecutor();

    await executor.executeStartSession(aStartSession(), PARTNER, aStation(OCPPVersion.OCPP1_6));

    const commandId = handler16.sendStartSessionCommand.mock.calls[0][3];
    const capability = handler16.sendStartSessionCommand.mock.calls[0][4];
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = cache.set.mock.calls.find((call) => call[2] === 'ocpi-command-callback-v1');
    expect(stored?.[1]).not.toContain(capability);
    expect(JSON.parse(stored?.[1]).digest).toBe(
      createHash('sha256').update(capability).digest('hex'),
    );
    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledWith(
      commandId,
      RESPONSE_URL,
      COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
      TIMEOUT,
    );
    expect(cache.onChange).toHaveBeenCalledWith(
      commandId,
      TIMEOUT,
      COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
    );
  });

  it('a handler failure propagates to the caller', async () => {
    const { executor, handler16 } = anExecutor();
    handler16.sendStartSessionCommand.mockRejectedValue(new Error('station unreachable'));

    await expect(
      executor.executeStartSession(aStartSession(), PARTNER, aStation(OCPPVersion.OCPP1_6)),
    ).rejects.toThrow('station unreachable');
  });
});

describe('CommandExecutor with no handler for the protocol', () => {
  // ocpp2.1 has no registered handler; null is a station whose protocol was never recorded.
  it.each([OCPPVersion.OCPP2_1, null])(
    'protocol %s posts FAILED to the response url instead of dispatching',
    async (protocol) => {
      const { executor, handler16, handler201, postCommandResult } = anExecutor();

      await executor.executeStartSession(aStartSession(), PARTNER, aStation(protocol));

      expect(handler16.sendStartSessionCommand).not.toHaveBeenCalled();
      expect(handler201.sendStartSessionCommand).not.toHaveBeenCalled();
      expect(postCommandResult).toHaveBeenCalledOnce();
      const [partner, url, result, commandId] = postCommandResult.mock.calls[0];
      expect(partner).toBe(PARTNER);
      expect(url).toBe(RESPONSE_URL);
      expect(result).toEqual({ result: CommandResultType.FAILED, message: FAILED_MESSAGE });
      expect(commandId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});

describe('CommandExecutor command timeout', () => {
  it('a cache entry that expires unresolved posts TIMEOUT to the response url', async () => {
    const { executor, cache, postCommandResult, handler16 } = anExecutor();
    cache.onChange.mockResolvedValue(null);

    await executor.executeStartSession(aStartSession(), PARTNER, aStation(OCPPVersion.OCPP1_6));
    await vi.waitFor(() => expect(postCommandResult).toHaveBeenCalledOnce());

    const commandId = handler16.sendStartSessionCommand.mock.calls[0][3];
    expect(postCommandResult).toHaveBeenCalledWith(
      PARTNER,
      RESPONSE_URL,
      { result: CommandResultType.TIMEOUT, message: FAILED_MESSAGE },
      commandId,
    );
  });

  it('a cache entry marked resolved posts nothing', async () => {
    const { executor, postCommandResult } = anExecutor();

    await executor.executeStartSession(aStartSession(), PARTNER, aStation(OCPPVersion.OCPP1_6));
    await flushCallbacks();

    expect(postCommandResult).not.toHaveBeenCalled();
  });
});

describe('CommandExecutor.handleAsyncCommandResponse', () => {
  const capability = 'private-random-proof';
  const ocppResponse = { status: 'Accepted' };
  function callback(version = OCPPVersion.OCPP1_6) {
    const fixture = anExecutor(true);
    const context = {
      digest: createHash('sha256').update(capability).digest('hex'),
      tenantPartnerId: 11,
      tenantId: 7,
      version,
      command: CommandType.START_SESSION,
      responseUrl: RESPONSE_URL,
      expiresAt: Date.now() + TIMEOUT * 1000,
    };
    fixture.cache.get.mockImplementation(async (_key: string, namespace: string) =>
      namespace === 'ocpi-command-callback-v1' ? JSON.stringify(context) : RESPONSE_URL,
    );
    fixture.request.mockResolvedValue({ TenantPartners_by_pk: PARTNER });
    return { ...fixture, context };
  }

  it.each([OCPPVersion.OCPP1_6, OCPPVersion.OCPP2_0_1, OCPPVersion.OCPP2_1])(
    'relays ordinary %s responses without changing the payload',
    async (version) => {
      const { executor, handler16, handler201, handler21 } = callback(version);
      await executor.handleAsyncCommandResponse(
        11,
        version,
        CommandType.START_SESSION,
        'cmd-1',
        ocppResponse,
        capability,
      );
      const handler =
        version === OCPPVersion.OCPP1_6
          ? handler16
          : version === OCPPVersion.OCPP2_1
            ? handler21
            : handler201;
      expect(handler.handleAsyncCommandResponse).toHaveBeenCalledExactlyOnceWith(
        PARTNER,
        CommandType.START_SESSION,
        RESPONSE_URL,
        ocppResponse,
        'cmd-1',
      );
    },
  );

  it.each([
    ['TIMED_OUT', CommandResultType.TIMEOUT],
    ['CALL_ERROR', CommandResultType.FAILED],
    ['DISPATCH_FAILED', CommandResultType.FAILED],
  ])('maps Core %s without leaking internal details', async (outcome, result) => {
    const { executor, handler16, postCommandResult } = callback();
    await executor.handleAsyncCommandResponse(
      11,
      OCPPVersion.OCPP1_6,
      CommandType.START_SESSION,
      'cmd-1',
      { success: false, outcome, error: 'private-error', details: { secret: 'private-secret' } },
      capability,
    );
    expect(handler16.handleAsyncCommandResponse).not.toHaveBeenCalled();
    expect(postCommandResult).toHaveBeenCalledExactlyOnceWith(
      PARTNER,
      RESPONSE_URL,
      { result, message: FAILED_MESSAGE },
      'cmd-1',
    );
  });

  it.each([undefined, '', 'wrong-proof'])(
    'rejects invalid proof before owner lookup',
    async (proof) => {
      const { executor, request, postCommandResult } = callback();
      await expect(
        executor.handleAsyncCommandResponse(
          11,
          OCPPVersion.OCPP1_6,
          CommandType.START_SESSION,
          'cmd-1',
          { success: false, outcome: 'CALL_ERROR' },
          proof,
        ),
      ).rejects.toThrow('Invalid callback context');
      expect(request).not.toHaveBeenCalled();
      expect(postCommandResult).not.toHaveBeenCalled();
    },
  );

  it.each(['tenantPartnerId', 'version', 'command', 'expiry', 'missing'])(
    'rejects wrong %s context',
    async (field) => {
      const { executor, request, context, cache } = callback();
      if (field === 'tenantPartnerId') context.tenantPartnerId = 12;
      if (field === 'version') context.version = OCPPVersion.OCPP2_0_1;
      if (field === 'command') context.command = CommandType.STOP_SESSION;
      if (field === 'expiry') context.expiresAt = Date.now() - 1;
      if (field === 'missing') cache.get.mockResolvedValue(null);
      await expect(
        executor.handleAsyncCommandResponse(
          11,
          OCPPVersion.OCPP1_6,
          CommandType.START_SESSION,
          'cmd-1',
          ocppResponse,
          capability,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('rejects a response URL that differs from server context before lookup', async () => {
    const { executor, context, request } = callback();
    context.responseUrl = 'https://another.test';
    await expect(
      executor.handleAsyncCommandResponse(
        11,
        OCPPVersion.OCPP1_6,
        CommandType.START_SESSION,
        'cmd-1',
        ocppResponse,
        capability,
      ),
    ).rejects.toThrow('Invalid callback context');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects ownership changes without sending a result', async () => {
    const { executor, request, postCommandResult } = callback();
    request.mockResolvedValue({ TenantPartners_by_pk: { ...partnerData, tenantId: 8 } });
    await expect(
      executor.handleAsyncCommandResponse(
        11,
        OCPPVersion.OCPP1_6,
        CommandType.START_SESSION,
        'cmd-1',
        ocppResponse,
        capability,
      ),
    ).rejects.toThrow('Invalid callback owner');
    expect(postCommandResult).not.toHaveBeenCalled();
  });

  it('ignores a resolved command after authenticating proof', async () => {
    const { executor, cache, context, request } = callback();
    cache.get.mockImplementation(async (_key: string, namespace: string) =>
      namespace === 'ocpi-command-callback-v1'
        ? JSON.stringify(context)
        : COMMAND_RESPONSE_URL_CACHE_RESOLVED,
    );
    await executor.handleAsyncCommandResponse(
      11,
      OCPPVersion.OCPP1_6,
      CommandType.START_SESSION,
      'cmd-1',
      ocppResponse,
      capability,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
