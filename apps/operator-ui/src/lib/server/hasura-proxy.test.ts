// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { operatorHasuraConfig, proxyOperatorHasura } from './hasura-proxy';
import type { OperatorHasuraConfig } from './hasura-proxy';
import { getHasuraAdminSecretAction } from './actions/get-hasura-admin-secret-action';

const config: OperatorHasuraConfig = {
  tenantId: 7,
  publicOrigin: 'https://operator.test',
  coreOrigin: 'https://core.test',
  endpoint: 'https://hasura.test/v1/graphql',
  adminSecret: 'private-hasura-key',
  role: 'user',
  timeoutMs: 1000,
};
const session = { user: { roles: ['admin'] } };
function request(
  payload: unknown = { query: 'query { Locations { id } }' },
  headers: Record<string, string> = {},
  url = 'https://operator.test/api/graphql',
) {
  return new Request(url, {
    method: 'POST',
    headers: { origin: config.publicOrigin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}
function transport() {
  return vi.fn<typeof fetch>(async () => Response.json({ data: { Locations: [{ id: 1 }] } }));
}

describe('Operator Hasura browser credential boundary', () => {
  it('refuses the legacy credential action unconditionally', async () => {
    expect(await getHasuraAdminSecretAction()).toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Browser Hasura credentials are disabled',
    });
  });

  it('requires a valid server admin session, including for reads', async () => {
    const fetcher = transport();
    for (const [identity, status] of [
      [null, 401],
      [{ ...session, error: 'expired' }, 401],
      [{ user: { roles: ['operator'] } }, 403],
      [{ user: { roles: ['user'] } }, 403],
    ] as const) {
      const identitySession = identity
        ? { ...identity, user: { roles: [...identity.user.roles] } }
        : null;
      expect((await proxyOperatorHasura(request(), identitySession, config, fetcher)).status).toBe(
        status,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { query: 'query { Locations { id } }' },
    {
      query:
        'mutation Add($row: Locations_insert_input!) { insert_Locations_one(object: $row) { id } }',
      variables: { row: { tenantId: 7, name: 'Depot' } },
    },
  ])('forwards reads and writes only with the server tenant and user role', async (payload) => {
    const fetcher = transport();
    const response = await proxyOperatorHasura(
      request(payload, {
        authorization: 'Bearer browser-token',
        cookie: 'browser-cookie',
      }),
      session,
      config,
      fetcher,
    );
    expect(response.status).toBe(200);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(config.endpoint);
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'x-hasura-admin-secret': config.adminSecret,
      'x-hasura-role': 'user',
      'x-hasura-tenant-id': '7',
    });
    expect(init?.body).toBe(JSON.stringify(payload));
    expect(init?.redirect).toBe('error');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain(config.adminSecret);
  });

  it('rejects browser role, tenant, secret, endpoint and cross-origin overrides', async () => {
    const fetcher = transport();
    const attempts = [
      request(undefined, { 'x-hasura-role': 'admin' }),
      request(undefined, { 'x-hasura-tenant-id': '8' }),
      request(undefined, { 'x-hasura-admin-secret': 'attacker' }),
      request(undefined, { origin: 'https://attacker.test' }),
      request(undefined, { 'sec-fetch-site': 'cross-site' }),
      request(undefined, {}, 'https://operator.test/api/graphql?tenantId=8'),
      request(undefined, {}, 'https://attacker.test/api/graphql'),
      request(undefined, {}, 'https://operator.test/api/graphql/v1/metadata'),
      request({ query: 'query { Locations { id } }', headers: { 'x-hasura-role': 'admin' } }),
    ];
    for (const attempt of attempts) {
      expect(
        (await proxyOperatorHasura(attempt, session, config, fetcher)).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds requests and rejects batches, subscriptions and ambiguous operations', async () => {
    const fetcher = transport();
    for (const payload of [
      [{ query: '{ Locations { id } }' }],
      { query: 'subscription { Locations { id } }' },
      { query: 'query A { Locations { id } } query B { Locations { id } }' },
      { query: 'x'.repeat(262145) },
    ]) {
      expect(
        (await proxyOperatorHasura(request(payload), session, config, fetcher)).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never reflects upstream failures, headers, extensions or secret-bearing data', async () => {
    const fetcher = transport();
    for (const upstream of [
      Response.json({ errors: [{ message: config.adminSecret }] }),
      Response.json({ data: { leaked: config.adminSecret } }),
      new Response(config.adminSecret, { status: 403 }),
      Response.json({ data: { big: 'x'.repeat(1048576) } }),
    ]) {
      fetcher.mockResolvedValueOnce(upstream);
      const response = await proxyOperatorHasura(request(), session, config, fetcher);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(config.adminSecret);
    }
    fetcher.mockResolvedValueOnce(
      Response.json(
        { data: { Locations: [] }, extensions: { secret: config.adminSecret } },
        { headers: { 'x-hasura-admin-secret': config.adminSecret } },
      ),
    );
    const safe = await proxyOperatorHasura(request(), session, config, fetcher);
    expect(await safe.json()).toEqual({ data: { Locations: [] } });
    expect(safe.headers.has('x-hasura-admin-secret')).toBe(false);
  });

  it('enforces a deadline even when the upstream ignores abort', async () => {
    const fetcher = transport();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const response = await proxyOperatorHasura(
      request(),
      session,
      { ...config, timeoutMs: 5 },
      fetcher,
    );
    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('requires explicit generic server configuration and the non-admin user role', () => {
    const env = {
      NEXT_PUBLIC_CORE_TRANSPORT: 'server',
      NEXT_PUBLIC_AUTH_PROVIDER: 'generic',
      NEXT_PUBLIC_TENANT_ID: '7',
      OPERATOR_CORE_TENANT_ID: '7',
      OPERATOR_CORE_URL: config.coreOrigin,
      NEXTAUTH_URL: config.publicOrigin,
      OPERATOR_HASURA_URL: config.endpoint,
      HASURA_ADMIN_SECRET: config.adminSecret,
      OPERATOR_HASURA_ROLE: 'user',
    };
    expect(operatorHasuraConfig(env).tenantId).toBe(7);
    for (const override of [
      { OPERATOR_HASURA_ROLE: 'admin' },
      { OPERATOR_HASURA_ROLE: '' },
      { NEXT_PUBLIC_TENANT_ID: '8' },
      { HASURA_ADMIN_SECRET: '' },
      { NEXT_PUBLIC_AUTH_PROVIDER: 'keycloak' },
      { OPERATOR_HASURA_URL: 'https://hasura.test/v1/metadata' },
      { OPERATOR_HASURA_URL: 'https://hasura.test/v1/graphql?url=other' },
      { OPERATOR_HASURA_URL: 'https://user:password@hasura.test/v1/graphql' },
    ])
      expect(() => operatorHasuraConfig({ ...env, ...override })).toThrow();
  });
});
