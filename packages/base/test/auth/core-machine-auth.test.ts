// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { CoreMachineTokenProvider, waitForCoreAbort } from '../../src/auth/core-machine-auth.js';
import type { CoreMachineAuthSettings } from '../../src/auth/core-machine-auth.js';

const settings: CoreMachineAuthSettings = {
  tokenUrl: 'https://iam.test/token',
  coreUrl: 'https://core.test',
  clientId: 'ocpi-client',
  clientSecret: 'test-only-secret',
  issuer: 'https://iam.test',
  audience: 'citrineos-core',
  role: 'evyar-ocpi',
  scope: 'citrineos:ocpi:invoke',
  timeoutMs: 1000,
};
function jwt(tenant: number, overrides: Record<string, unknown> = {}): string {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded({ alg: 'RS256', kid: 'test-key' })}.${encoded({
    iss: settings.issuer,
    aud: settings.audience,
    sub: settings.clientId,
    exp: Math.floor(Date.now() / 1000) + 300,
    actor_type: 'service',
    core_tenant_id: tenant,
    core_roles: ['evyar-ocpi'],
    scopes: ['citrineos:ocpi:invoke'],
    ...overrides,
  })}.test_signature`;
}
function tokenResponse(tenant: number, overrides: Record<string, unknown> = {}) {
  return Response.json({
    access_token: jwt(tenant, overrides),
    token_type: 'Bearer',
    expires_in: 300,
  });
}

describe('Core machine credential boundary', () => {
  it('observes pending rejections before throwing for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = Promise.reject(new Error('pending read failed'));
    const observed = vi.spyOn(pending, 'catch');
    expect(() => waitForCoreAbort(pending, controller.signal)).toThrow();
    expect(observed).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each(['fetch', 'body'])(
    'rejects token completion after a delayed %s deadline even before the timer runs',
    async (phase) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const body = JSON.stringify({ access_token: jwt(7), token_type: 'Bearer', expires_in: 300 });
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (phase === 'fetch') {
          now += 2000;
          return new Response(body);
        }
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                now += 2000;
                controller.enqueue(new TextEncoder().encode(body));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      });
      try {
        await expect(new CoreMachineTokenProvider(settings, fetcher).token(7)).rejects.toThrow(
          'Core machine authentication failed',
        );
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(['fetch', 'body'])(
    'rejects Core completion after a delayed %s deadline without replay',
    async (phase) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let commands = 0;
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (String(url) === settings.tokenUrl) return tokenResponse(7);
        commands++;
        if (phase === 'fetch') {
          now += 2000;
          return Response.json([{ success: true }]);
        }
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                now += 2000;
                controller.enqueue(new TextEncoder().encode('[{"success":true}]'));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      });
      try {
        const provider = new CoreMachineTokenProvider(settings, fetcher);
        await expect(
          provider.request(7, new URL('https://core.test/x?tenantId=7'), {
            method: 'POST',
            body: '{}',
          }),
        ).rejects.toThrow('Core machine request failed');
        expect(commands).toBe(1);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('single-flights within a tenant and separates concurrent tenants', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) !== settings.tokenUrl) throw new Error('Unexpected network');
      const parsed: unknown = JSON.parse(String(init?.body));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('coreTenantId' in parsed) ||
        typeof parsed.coreTenantId !== 'number'
      )
        throw new Error('Unexpected grant');
      return tokenResponse(parsed.coreTenantId);
    });
    const provider = new CoreMachineTokenProvider(settings, fetcher);
    const tokens = await Promise.all([provider.token(7), provider.token(7), provider.token(8)]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[0]).not.toBe(tokens[2]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      grantType: 'client_credentials',
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      audience: 'citrineos-core',
      scope: 'citrineos:ocpi:invoke',
      coreTenantId: 7,
    });
  });

  it.each([
    { aud: 'other-api' },
    { core_tenant_id: 8 },
    { core_roles: ['admin'] },
    { core_roles: ['evyar-ocpi', 'admin'] },
    { scopes: ['citrineos:operator:invoke'] },
    { actor_type: 'user' },
    { iss: 'https://other.test' },
    { sub: '' },
    { sub: 'another-client' },
    { exp: 1 },
  ])('rejects a mismatched issuer resource binding %j', async (claims) => {
    const provider = new CoreMachineTokenProvider(
      settings,
      vi.fn<typeof fetch>(async () => tokenResponse(7, claims)),
    );
    await expect(provider.token(7)).rejects.toThrow('Core machine authentication failed');
  });

  it('refreshes a cached token before its expiry margin', async () => {
    const initial = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(initial);
    const fetcher = vi.fn<typeof fetch>(async () => tokenResponse(7));
    try {
      const provider = new CoreMachineTokenProvider(settings, fetcher);
      await provider.token(7);
      await provider.token(7);
      expect(fetcher).toHaveBeenCalledOnce();
      now.mockReturnValue(initial + 271000);
      await provider.token(7);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('only replays an explicit 401 once, refreshing its token', async () => {
    let grants = 0;
    let commands = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === settings.tokenUrl) {
        grants++;
        return tokenResponse(7);
      }
      if (String(url) !== 'https://core.test/ocpp/1.6/evdriver/remoteStartTransaction?tenantId=7')
        throw new Error('Unexpected network');
      commands++;
      return commands === 1
        ? Response.json({}, { status: 401 })
        : Response.json([{ success: true }]);
    });
    const provider = new CoreMachineTokenProvider(settings, fetcher);
    const response = await provider.request(
      7,
      new URL('https://core.test/ocpp/1.6/evdriver/remoteStartTransaction?tenantId=7'),
      { method: 'POST', body: '{}' },
    );
    expect(response.status).toBe(200);
    expect(grants).toBe(2);
    expect(commands).toBe(2);
  });

  it('never replays an ambiguous network failure or sends credentials to another origin', async () => {
    let commands = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === settings.tokenUrl) return tokenResponse(7);
      commands++;
      throw new Error('network error containing test-only-secret');
    });
    const provider = new CoreMachineTokenProvider(settings, fetcher);
    await expect(
      provider.request(7, new URL('https://core.test/x?tenantId=7'), {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Core machine request failed');
    expect(commands).toBe(1);
    await expect(
      provider.request(7, new URL('https://attacker.test/x?tenantId=7'), { method: 'POST' }),
    ).rejects.toThrow('Core origin mismatch');
    expect(commands).toBe(1);
  });

  it('bounds unresponsive acquisition and rejects oversized bodies without leaking issuer errors', async () => {
    const stalled = new CoreMachineTokenProvider(
      { ...settings, timeoutMs: 10 },
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
    await expect(stalled.token(7)).rejects.toThrow('Core machine authentication failed');
    const oversized = new CoreMachineTokenProvider(
      settings,
      vi.fn<typeof fetch>(async () => new Response('secret'.repeat(12000))),
    );
    await expect(oversized.token(7)).rejects.toThrow('Core machine authentication failed');
  });
});
