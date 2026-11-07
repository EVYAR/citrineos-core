// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RoleDefinitionsSchema } from '@citrineos/types';
import { JwtAuthProvider } from '@/apis/authorization/provider/jwt-auth-provider.js';
import { PolicyStore } from '@/apis/authorization/policy/policy-store.js';
import { aSystemConfig } from '@test/providers/system-config.js';

const issuer = 'https://synthetic-iam.invalid';
const audience = 'citrineos-core';
const uuidTenant = '00000000-0000-4000-8000-000000000001';
const seed = RoleDefinitionsSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../../apps/ocpp-server/src/assets/roles-seed.json', import.meta.url),
      'utf8',
    ),
  ),
);
// Frozen adapter handoff: docs/upgrades/core-api-machine-policy.json; intentional exact seed contract.
const expected = RoleDefinitionsSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../fixtures/evyar-adapter-policy.json', import.meta.url), 'utf8'),
  ),
);
let keys: { publicKey: KeyObject; privateKey: KeyObject };
let otherKeys: { publicKey: KeyObject; privateKey: KeyObject };
let policy: PolicyStore;
beforeAll(async () => {
  keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  otherKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  policy = new PolicyStore({
    config: aSystemConfig({ roles: { common: [] } }),
    roleProvider: { listRoles: vi.fn(async () => seed) },
    permissionCatalog: new Set(expected['evyar-adapter'].permissions),
  });
  await policy.refresh();
});
function provider(requiredTenantClaim = true) {
  return new JwtAuthProvider(
    {
      publicKey: keys.publicKey,
      issuer,
      audience,
      rolesClaim: 'core_roles',
      tenantClaim: 'core_tenant_id',
      requiredTenantClaim,
      defaultTenantId: '1',
    },
    policy,
  );
}
function token(overrides: Record<string, unknown> = {}, wrongSignature = false) {
  return jwt.sign(
    {
      sub: 'synthetic-adapter',
      iss: issuer,
      aud: audience,
      tenant_id: uuidTenant,
      core_tenant_id: 1,
      core_roles: ['evyar-adapter'],
      ...overrides,
    },
    wrongSignature ? otherKeys.privateKey : keys.privateKey,
    {
      algorithm: 'ES256',
      keyid: 'synthetic-only',
      expiresIn: 60,
    },
  );
}
describe('EVYAR dedicated Core signed JWT boundary', () => {
  it('retains the opt-in flag in externally signed JWT configuration', () => {
    const config = aSystemConfig({
      auth: {
        mode: 'jwt',
        jwt: {
          jwksUri: 'https://synthetic-iam.invalid/jwks',
          issuer,
          audience,
          rolesClaim: 'core_roles',
          tenantClaim: 'core_tenant_id',
          requiredTenantClaim: true,
        },
      },
    });
    expect(config.auth.jwt?.requiredTenantClaim).toBe(true);
    expect(aSystemConfig().auth.mode).toBe('localDev');
    expect(aSystemConfig().auth.jwt?.requiredTenantClaim).toBeUndefined();
  });
  it.each([
    undefined,
    null,
    '',
    ' ',
    '01',
    '1.0',
    '1e0',
    ' 1',
    '1 ',
    uuidTenant,
    true,
    [],
    {},
    0,
    -1,
    1.5,
    2147483648,
  ])('rejects missing or malformed private Core tenant claim %j', async (claim) => {
    const result = await provider().authenticateToken(token({ core_tenant_id: claim }));
    expect(result.isAuthenticated).toBe(false);
    expect(result.user).toBeUndefined();
  });
  it.each([1, '1', 2147483647, '2147483647'])(
    'accepts exact numeric Core tenant %j',
    async (claim) => {
      const result = await provider().authenticateToken(token({ core_tenant_id: claim }));
      expect(result.isAuthenticated).toBe(true);
      expect(result.user?.tenantId).toBe(String(claim));
      expect(result.user?.tenantId).not.toBe(uuidTenant);
      expect(result.user?.roles).toEqual(['evyar-adapter']);
    },
  );
  it.each([{ aud: 'other-service' }, { iss: 'https://other-issuer.invalid' }])(
    'rejects signed wrong audience or issuer %j',
    async (claims) => {
      expect((await provider().authenticateToken(token(claims))).isAuthenticated).toBe(false);
    },
  );
  it('rejects a different signing key', async () => {
    expect((await provider().authenticateToken(token({}, true))).isAuthenticated).toBe(false);
  });
  it('keeps opt-out default tenant fallback', async () => {
    const result = await provider(false).authenticateToken(token({ core_tenant_id: undefined }));
    expect(result.isAuthenticated).toBe(true);
    expect(result.user?.tenantId).toBe('1');
  });
  it('does not derive Core roles from ordinary roles or scopes', async () => {
    const result = await provider().authenticateToken(
      token({
        core_roles: undefined,
        roles: ['admin'],
        scope: 'ocpp.configuration.reset',
      }),
    );
    expect(result.user?.roles).toEqual([]);
  });
  it('installs exactly the reviewed adapter machine role, without UI resources', () => {
    expect(seed['evyar-adapter']).toEqual(expected['evyar-adapter']);
    expect(seed['evyar-adapter'].resources).toEqual({});
    expect(seed['evyar-adapter'].permissions).toHaveLength(49);
    expect(policy.permissionsFor(['evyar-adapter'])).toEqual({
      resources: {},
      permissions: [...expected['evyar-adapter'].permissions].sort(),
    });
    for (const permission of expected['evyar-adapter'].permissions) {
      expect(policy.hasPermission(['evyar-adapter'], permission)).toBe(true);
    }
    expect(policy.hasPermission(['evyar-adapter'], 'commands.tariff.delete')).toBe(false);
    expect(policy.hasPermission(['evyar-adapter'], 'commands.installRootCertificate.put')).toBe(
      false,
    );
    expect(policy.hasPermission(['ungranted-role'], 'ocpp.configuration.reset')).toBe(false);
  });
  it('keeps roaming commands separate from operator management permissions', () => {
    for (const action of [
      'remoteStartTransaction',
      'remoteStopTransaction',
      'requestStartTransaction',
      'requestStopTransaction',
      'unlockConnector',
    ]) {
      expect(policy.hasPermission(['evyar-ocpi'], `ocpp.evdriver.${action}`)).toBe(true);
    }
    expect(policy.permissionsFor(['evyar-ocpi']).resources).toEqual({});
    expect(policy.hasPermission(['evyar-ocpi'], 'ocpp.configuration.reset')).toBe(false);
    expect(policy.hasPermission(['evyar-ocpi'], 'commands.setStationPassword.post')).toBe(false);
    expect(policy.hasPermission(['evyar-operator'], 'ocpp.configuration.reset')).toBe(true);
    expect(policy.hasPermission(['evyar-operator'], 'commands.setStationPassword.post')).toBe(true);
    expect(policy.hasPermission(['evyar-operator'], 'commands.tariff.delete')).toBe(false);
    expect(policy.hasPermission(['evyar-operator'], 'ocpprouter.subscription.post')).toBe(false);
    expect(policy.permissionsFor(['evyar-operator']).resources.Transactions).not.toContain(
      'delete',
    );
  });
  it.each([
    { query: '1', body: 1, allowed: true },
    { query: '2', body: 2, allowed: false },
    { query: '1', body: 2, allowed: false },
    { query: '2', body: 1, allowed: false },
  ])('authorizes both query and body tenant boundaries %j', async ({ query, body, allowed }) => {
    const auth = provider();
    const app = Fastify();
    app.post(
      '/synthetic',
      { config: { permission: 'ocpp.configuration.reset' } },
      async (request, reply) => {
        const bearer = await auth.extractToken(request);
        const result = await auth.authenticateToken(bearer ?? '');
        if (!result.user) return reply.code(401).send();
        const decision = await auth.authorizeUser(result.user, request);
        return reply.code(decision.isAuthorized ? 200 : 403).send();
      },
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/synthetic?tenantId=${query}`,
        headers: { authorization: `Bearer ${token()}` },
        payload: { tenantId: body },
      });
      expect(response.statusCode).toBe(allowed ? 200 : 403);
    } finally {
      await app.close();
    }
  });
});
