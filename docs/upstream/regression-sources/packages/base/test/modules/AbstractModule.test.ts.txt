// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { ICache, IMessageHandler, IMessageSender } from '../../index.js';
import {
  AbstractModule,
  CacheNamespace,
  createIdentifier,
  EventGroup,
  OCPP_CallAction,
  OCPPVersion,
  OCPPValidator,
} from '../../index.js';
import { beforeEach, describe, expect, it, type Mocked, vi } from 'vitest';

class TestModule extends AbstractModule {}

const TENANT_ID = 1;
const STATION_ID = 'CS001';
const CORRELATION_ID = 'correlation-123';
const CALLBACK_URL = 'http://adapter/callback';
const ACTION = OCPP_CallAction.Reset;
const PAYLOAD = { type: 'Soft' } as never;

function buildCache(): Mocked<ICache> {
  return {
    exists: vi.fn().mockResolvedValue(false),
    existsAnyInNamespace: vi.fn().mockResolvedValue(false),
    remove: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(true),
    setIfNotExist: vi.fn().mockResolvedValue(true),
    onChange: vi.fn().mockResolvedValue(null),
  } as unknown as Mocked<ICache>;
}

describe('AbstractModule sendCall outcomes', () => {
  let cache: Mocked<ICache>;
  let sender: Mocked<IMessageSender>;
  let module: TestModule;

  beforeEach(() => {
    cache = buildCache();
    sender = {
      send: vi.fn().mockResolvedValue({ success: true }),
      sendRequest: vi.fn().mockResolvedValue({ success: true }),
      sendResponse: vi.fn().mockResolvedValue({ success: true }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as Mocked<IMessageSender>;
    const handler = {
      subscribe: vi.fn().mockResolvedValue(true),
      unsubscribe: vi.fn().mockResolvedValue(true),
      handle: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      module: undefined,
    } as unknown as Mocked<IMessageHandler>;
    const moduleLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      settings: { minLevel: 0 },
    };
    const baseLogger = {
      getSubLogger: vi.fn().mockReturnValue(moduleLogger),
    };
    const validator = {
      sanitizeOCPPPayload: vi.fn((payload) => payload),
      validateOCPPRequest: vi.fn().mockReturnValue({ isValid: true }),
    } as unknown as OCPPValidator;

    module = new TestModule(
      { maxCachingSeconds: 60, logLevel: 0 } as never,
      cache,
      handler,
      sender,
      EventGroup.EVDriver,
      baseLogger as never,
      validator,
    );
  });

  it('does not dispatch when callback registration is rejected', async () => {
    cache.set.mockResolvedValueOnce(false);

    const result = await module.sendCall(
      STATION_ID,
      TENANT_ID,
      OCPPVersion.OCPP1_6,
      ACTION,
      PAYLOAD,
      CALLBACK_URL,
      CORRELATION_ID,
    );

    expect(result).toEqual({
      success: false,
      payload: expect.objectContaining({
        outcome: 'CALLBACK_REGISTRATION_FAILED',
        correlationId: CORRELATION_ID,
        error: expect.objectContaining({ code: 'CALLBACK_CACHE_REJECTED' }),
      }),
    });
    expect(sender.sendRequest).not.toHaveBeenCalled();
  });

  it('returns a distinct outcome when callback registration throws', async () => {
    cache.set.mockRejectedValueOnce(new Error('cache unavailable'));

    const result = await module.sendCall(
      STATION_ID,
      TENANT_ID,
      OCPPVersion.OCPP1_6,
      ACTION,
      PAYLOAD,
      CALLBACK_URL,
      CORRELATION_ID,
    );

    expect(result.payload).toEqual(
      expect.objectContaining({
        outcome: 'CALLBACK_REGISTRATION_FAILED',
        error: expect.objectContaining({
          code: 'CALLBACK_CACHE_ERROR',
          details: { cause: 'cache unavailable' },
        }),
      }),
    );
    expect(sender.sendRequest).not.toHaveBeenCalled();
  });

  it('returns protocol mismatch and removes the unused callback registration', async () => {
    cache.get.mockResolvedValueOnce(JSON.stringify({ protocol: OCPPVersion.OCPP2_0_1 }));

    const result = await module.sendCall(
      STATION_ID,
      TENANT_ID,
      OCPPVersion.OCPP1_6,
      ACTION,
      PAYLOAD,
      CALLBACK_URL,
      CORRELATION_ID,
    );

    expect(result.payload).toEqual(
      expect.objectContaining({
        outcome: 'DISPATCH_FAILED',
        error: expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
      }),
    );
    expect(cache.remove).toHaveBeenCalledWith(
      CORRELATION_ID,
      AbstractModule.CALLBACK_URL_CACHE_PREFIX + STATION_ID,
    );
    expect(sender.sendRequest).not.toHaveBeenCalled();
  });

  it('forwards when the module connection cache is stale so the router owns the outcome', async () => {
    cache.get.mockResolvedValueOnce(null);

    await module.sendCall(
      STATION_ID,
      TENANT_ID,
      OCPPVersion.OCPP1_6,
      ACTION,
      PAYLOAD,
      CALLBACK_URL,
      CORRELATION_ID,
    );

    expect(sender.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ACTION,
        context: expect.objectContaining({
          correlationId: CORRELATION_ID,
          ocppConnectionName: STATION_ID,
          tenantId: TENANT_ID,
        }),
      }),
    );
    expect(cache.get).toHaveBeenCalledWith(
      createIdentifier(TENANT_ID, STATION_ID),
      CacheNamespace.Connections,
    );
  });
});
