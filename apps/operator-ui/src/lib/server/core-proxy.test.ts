// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { operatorCoreConfig, proxyOperatorCore } from './core-proxy';
import type { OperatorCoreTransport } from './core-proxy';

const config = {
  tenantId: 7,
  publicOrigin: 'https://operator.test',
  coreOrigin: 'https://core.test',
  timeoutMs: 1000,
};
const session = { user: { roles: ['admin'] } };
const path = ['ocpp', '1.6', 'evdriver', 'remoteStartTransaction'];
const target =
  'https://operator.test/api/core/ocpp/1.6/evdriver/remoteStartTransaction?identifier=cp001&tenantId=7';
function request(url = target, payload: unknown = { idTag: 'TAG' }, origin = config.publicOrigin) {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      authorization: 'Bearer browser-token',
      cookie: 'session-cookie',
    },
    body: JSON.stringify(payload),
  });
}
function transport() {
  return {
    request: vi.fn<OperatorCoreTransport['request']>(async () => ({
      status: 200,
      contentType: 'application/json',
      body: '[{"success":true}]',
    })),
  };
}

describe('session-guarded Operator Core proxy', () => {
  it('requires a server session and trusted server operator role', async () => {
    const client = transport();
    expect((await proxyOperatorCore(request(), path, null, config, client)).status).toBe(401);
    expect(
      (await proxyOperatorCore(request(), path, { user: { roles: ['user'] } }, config, client))
        .status,
    ).toBe(403);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('forwards only the fixed tenant route and never browser credentials', async () => {
    const client = transport();
    const response = await proxyOperatorCore(request(), path, session, config, client);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ success: true }]);
    expect(client.request).toHaveBeenCalledOnce();
    const [tenant, url, init] = client.request.mock.calls[0]!;
    expect(tenant).toBe(7);
    expect(url.href).toBe(
      'https://core.test/ocpp/1.6/evdriver/remoteStartTransaction?identifier=cp001&tenantId=7',
    );
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  it('preserves the existing network-profile command and its configured server selector', async () => {
    const client = transport();
    const url =
      'https://operator.test/api/core/ocpp/2.0.1/configuration/setNetworkProfile?identifier=cp001&tenantId=7&websocketServerConfigId=server1';
    const response = await proxyOperatorCore(
      request(url, { configurationSlot: 1, connectionData: {} }),
      ['ocpp', '2.0.1', 'configuration', 'setNetworkProfile'],
      session,
      config,
      client,
    );
    expect(response.status).toBe(200);
    expect(client.request.mock.calls[0]?.[1].searchParams.get('websocketServerConfigId')).toBe(
      'server1',
    );
  });

  it('rejects cross-origin, arbitrary path/host and contradictory tenant requests', async () => {
    const client = transport();
    expect(
      (
        await proxyOperatorCore(
          request(target, {}, 'https://attacker.test'),
          path,
          session,
          config,
          client,
        )
      ).status,
    ).toBe(403);
    expect(
      (await proxyOperatorCore(request(), ['https:', 'attacker.test'], session, config, client))
        .status,
    ).toBe(403);
    expect(
      (
        await proxyOperatorCore(
          request(target.replace('tenantId=7', 'tenantId=8')),
          path,
          session,
          config,
          client,
        )
      ).status,
    ).toBe(400);
    expect(
      (await proxyOperatorCore(request(target + '&tenantId=7'), path, session, config, client))
        .status,
    ).toBe(400);
    expect(
      (
        await proxyOperatorCore(
          request(target, { nested: { tenantId: 8 } }),
          path,
          session,
          config,
          client,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await proxyOperatorCore(
          request(target + '&callbackUrl=https://attacker.test'),
          path,
          session,
          config,
          client,
        )
      ).status,
    ).toBe(400);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('preserves a rejected Core status without reflecting secrets or retrying', async () => {
    const client = transport();
    client.request.mockResolvedValue({
      status: 403,
      contentType: 'application/json',
      body: '{"message":"private-issuer-secret"}',
    });
    const response = await proxyOperatorCore(request(), path, session, config, client);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('private-issuer-secret');
    expect(client.request).toHaveBeenCalledOnce();
  });

  it('rejects an event-loop-delayed transport completion', async () => {
    const client = transport();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    client.request.mockImplementation(async () => {
      now += 2000;
      return { status: 200, contentType: 'application/json', body: '[{"success":true}]' };
    });
    try {
      expect((await proxyOperatorCore(request(), path, session, config, client)).status).toBe(502);
      expect(client.request).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects transport configuration inconsistent with the public fixed tenant', () => {
    expect(() =>
      operatorCoreConfig({
        NEXT_PUBLIC_CORE_TRANSPORT: 'server',
        OPERATOR_CORE_TENANT_ID: '7',
        NEXT_PUBLIC_TENANT_ID: '8',
        OPERATOR_CORE_URL: 'https://core.test',
        NEXTAUTH_URL: config.publicOrigin,
      }),
    ).toThrow('not configured');
  });
});
