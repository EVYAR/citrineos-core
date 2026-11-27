// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import 'reflect-metadata';
import { TenantPartnerSchema, type TenantPartnerDto } from '@citrineos/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from 'tslog';
import {
  COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
  COMMAND_RESPONSE_URL_CACHE_RESOLVED,
} from '@ocpi/util/consts.js';
import { CommandResultType } from '@ocpi/types/command-result.js';
import { CommandsClientApi } from '@ocpi/transport/trigger/commands-client-api.js';

const COMMAND_ID = 'cmd-1';
const COMMAND_TIMEOUT_SECONDS = 30;

function aCacheThatOnlyReadsWhenTheWaitElapses() {
  const entries = new Map<string, { value: string; expiresAt?: number }>();
  const get = async (key: string, namespace: string) => {
    const entry = entries.get(`${namespace}:${key}`);
    if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())) {
      return null;
    }
    return entry.value;
  };
  return {
    get,
    setIfNotExist: async (key: string, value: string, namespace: string, expireSeconds: number) => {
      const cacheKey = `${namespace}:${key}`;
      const entry = entries.get(cacheKey);
      if (entry && (entry.expiresAt === undefined || entry.expiresAt > Date.now())) return false;
      entries.set(cacheKey, { value, expiresAt: Date.now() + expireSeconds * 1000 });
      return true;
    },
    set: async (key: string, value: string, namespace: string, expireSeconds?: number) => {
      entries.set(`${namespace}:${key}`, {
        value,
        expiresAt: expireSeconds ? Date.now() + expireSeconds * 1000 : undefined,
      });
      return true;
    },
    onChange: (key: string, waitSeconds: number, namespace: string) =>
      new Promise<string | null>((resolve) => {
        setTimeout(() => resolve(get(key, namespace)), waitSeconds * 1000);
      }),
  };
}

function aClient(cache: ReturnType<typeof aCacheThatOnlyReadsWhenTheWaitElapses>) {
  const client = new CommandsClientApi({
    logger: new Logger({ type: 'hidden' }),
    ocpiGraphqlClient: {},
    cacheWrapper: { cache },
    config: { commands: { timeout: COMMAND_TIMEOUT_SECONDS } },
  } as never);
  return client;
}

function aPartner(): TenantPartnerDto {
  return TenantPartnerSchema.parse({
    countryCode: 'NL',
    partyId: 'MSP',
    tenant: { name: 'CPO', countryCode: 'GB', partyId: 'CPO' },
    partnerProfileOCPI: {
      version: { version: '2.2.1' },
      serverCredentials: { versionsUrl: 'https://ocpi.test/versions' },
      credentials: { token: 'partner-token', versionsUrl: 'https://msp.test/versions' },
    },
  });
}

describe('CommandsClientApi.postCommandResult', () => {
  it('arbitrates concurrent callback and timeout choices before HTTP delivery', async () => {
    const cache = aCacheThatOnlyReadsWhenTheWaitElapses();
    const client = aClient(cache);
    await Promise.all([
      client.postCommandResult(
        aPartner(),
        'https://msp.test/callback',
        { result: CommandResultType.ACCEPTED },
        COMMAND_ID,
      ),
      client.postCommandResult(
        aPartner(),
        'https://msp.test/callback',
        { result: CommandResultType.TIMEOUT },
        COMMAND_ID,
      ),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://msp.test/callback');
    expect(options?.body).toBe(JSON.stringify({ result: CommandResultType.ACCEPTED }));
    const headers = new Headers(options?.headers);
    expect(headers.get('authorization')).toBe(
      `Token ${Buffer.from('partner-token').toString('base64')}`,
    );
    expect(headers.get('OCPI-from-country-code')).toBe('GB');
    expect(headers.get('OCPI-from-party-id')).toBe('CPO');
    expect(headers.get('OCPI-to-country-code')).toBe('NL');
    expect(headers.get('OCPI-to-party-id')).toBe('MSP');
  });

  it('retains the terminal choice after ambiguous failed delivery', async () => {
    const client = aClient(aCacheThatOnlyReadsWhenTheWaitElapses());
    vi.mocked(fetch).mockRejectedValue(new Error('secret URL and token'));
    await expect(
      client.postCommandResult(
        aPartner(),
        'https://msp.test/callback',
        { result: CommandResultType.ACCEPTED },
        COMMAND_ID,
      ),
    ).rejects.toThrow('Command result delivery failed');
    await client.postCommandResult(
      aPartner(),
      'https://msp.test/callback',
      { result: CommandResultType.TIMEOUT },
      COMMAND_ID,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['headers', 'body'])('bounds hanging %s without a delivery retry', async (phase) => {
    const client = aClient(aCacheThatOnlyReadsWhenTheWaitElapses());
    vi.mocked(fetch).mockImplementation(async () =>
      phase === 'headers'
        ? new Promise<Response>(() => {})
        : new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) })),
    );
    const delivery = client.postCommandResult(
      aPartner(),
      'https://msp.test/callback',
      { result: CommandResultType.ACCEPTED },
      COMMAND_ID,
    );
    const assertion = expect(delivery).rejects.toThrow('Command result delivery failed');
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(fetch).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ status_code: 1000, timestamp: new Date().toISOString() }),
        ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the RESOLVED marker until a wait started when the command was sent has elapsed', async () => {
    const cache = aCacheThatOnlyReadsWhenTheWaitElapses();
    const client = aClient(cache);
    const wait = cache.onChange(
      COMMAND_ID,
      COMMAND_TIMEOUT_SECONDS,
      COMMAND_RESPONSE_URL_CACHE_NAMESPACE,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await client.postCommandResult(
      aPartner(),
      'https://msp.test/ocpi/commands/START_SESSION/1',
      { result: CommandResultType.ACCEPTED },
      COMMAND_ID,
    );
    await vi.advanceTimersByTimeAsync((COMMAND_TIMEOUT_SECONDS - 2) * 1000);

    await expect(wait).resolves.toBe(COMMAND_RESPONSE_URL_CACHE_RESOLVED);
  });
});
