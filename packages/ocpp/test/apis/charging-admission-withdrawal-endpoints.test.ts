// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from 'tslog';
import { CommandsApi } from '@/apis/commands-api.js';
import { PostChargingAdmissionWithdrawalEndpoint, GetChargingAdmissionWithdrawalEndpoint } from '@/apis/commands/charging-admission-withdrawal-endpoints.js';
import { apiAuthPluginFp } from '@/apis/authorization/api-auth-plugin.js';
import { JwtAuthProvider } from '@/apis/authorization/provider/jwt-auth-provider.js';
import { PolicyStore } from '@/apis/authorization/policy/policy-store.js';
import { buildPermissionCatalog } from '@/apis/register.js';
import { RoleDefinitionsSchema, type ChargingAdmissionWithdrawalRequest } from '@citrineos/types';
import type { ChargingAdmissionWithdrawalService } from '@/services/authorizer/charging-admission-withdrawal-service.js';
import { aSystemConfig } from '@test/providers/system-config.js';

const path = '/commands/chargingAdmissionWithdrawal';
const ref = '00000000-0000-4000-8000-000000000001';
const body: ChargingAdmissionWithdrawalRequest = { schemaVersion: '1.0.0', chargingCalloutRef: ref, idempotencyKey: 'adapter-withdrawal:original:callout', expectedCommercialTarget: { ocppConnectionName: 'station', protocol: 'ocpp1.6', ocppEvseId: 1, ocppConnectorId: 1 } };
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const seed = RoleDefinitionsSchema.parse(JSON.parse(readFileSync(new URL('../../../../apps/ocpp-server/src/assets/roles-seed.json', import.meta.url), 'utf8')));
const logger = new Logger({ type: 'hidden' });
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
function token(claims: Record<string, unknown> = {}) {
  return jwt.sign({ sub: 'normal-adapter', iss: 'https://issuer.invalid', aud: 'core', core_tenant_id: 1, core_roles: ['evyar-adapter'], ...claims }, keys.privateKey, { algorithm: 'ES256', expiresIn: 60 });
}
async function mount() {
  const policy = new PolicyStore({ config: aSystemConfig({ roles: { common: [] } }), roleProvider: { listRoles: async () => seed }, permissionCatalog: buildPermissionCatalog() });
  await policy.refresh();
  const provider = new JwtAuthProvider({ publicKey: keys.publicKey, issuer: 'https://issuer.invalid', audience: 'core', rolesClaim: 'core_roles', tenantClaim: 'core_tenant_id', requiredTenantClaim: true, defaultTenantId: '1' }, policy);
  app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  await app.register(apiAuthPluginFp, { provider, logger });
  const withdraw = vi.fn().mockResolvedValue({ coreEvidenceRef: 'core-withdrawal:stored', withdrawal: { durable: true } });
  const read = vi.fn().mockResolvedValue(null);
  const service = { withdraw, read } as unknown as ChargingAdmissionWithdrawalService;
  new CommandsApi({ server: app, logger, commandEndpoints: [
    { route: PostChargingAdmissionWithdrawalEndpoint.route, endpoint: new PostChargingAdmissionWithdrawalEndpoint({ logger, chargingAdmissionWithdrawalService: service }) },
    { route: GetChargingAdmissionWithdrawalEndpoint.route, endpoint: new GetChargingAdmissionWithdrawalEndpoint({ logger, chargingAdmissionWithdrawalService: service }) },
  ] });
  await app.ready();
  return { app, withdraw, read };
}
describe('normal authenticated owner withdrawal HTTP boundary', () => {
  it('generates only exact command/read permissions for the existing adapter role', () => {
    const catalog = buildPermissionCatalog();
    for (const suffix of ['post', 'get']) {
      const permission = `commands.chargingAdmissionWithdrawal.${suffix}`;
      expect(catalog.has(permission)).toBe(true);
      expect(seed['evyar-adapter'].permissions).toContain(permission);
      for (const [role, definition] of Object.entries(seed)) if (role !== 'evyar-adapter') expect(definition.permissions).not.toContain(permission);
    }
  });
  it('accepts the exact authenticated normal owner and forwards only stored request identity', async () => {
    const { app, withdraw } = await mount();
    const response = await app.inject({ method: 'POST', url: `${path}?tenantId=1`, headers: { authorization: `Bearer ${token()}` }, payload: body });
    expect(response.statusCode).toBe(200);
    expect(withdraw).toHaveBeenCalledWith(1, body, 'normal-adapter');
    expect(response.json().coreEvidenceRef).toBe('core-withdrawal:stored');
  });
  it.each([
    ['missing bearer', undefined, 1, 401],
    ['wrong tenant', token(), 2, 403],
    ['wrong issuer', token({ iss: 'https://wrong.invalid' }), 1, 401],
    ['wrong audience', token({ aud: 'other' }), 1, 401],
    ['ungranted role', token({ core_roles: ['admin'] }), 1, 403],
  ])('denies %s before owner persistence', async (_name, bearer, tenantId, status) => {
    const { app, withdraw, read } = await mount();
    const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
    expect((await app.inject({ method: 'POST', url: `${path}?tenantId=${tenantId}`, headers, payload: body })).statusCode).toBe(status);
    expect((await app.inject({ method: 'GET', url: `${path}?tenantId=${tenantId}&chargingCalloutRef=${ref}`, headers })).statusCode).toBe(status);
    expect(withdraw).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it('rejects unsigned caller proof and invalid physical-target values', async () => {
    const { app, withdraw } = await mount();
    for (const payload of [{ ...body, receipt: { durable: true } }, { ...body, expectedCommercialTarget: { ...body.expectedCommercialTarget, ocppConnectorId: 0 } }]) {
      expect((await app.inject({ method: 'POST', url: `${path}?tenantId=1`, headers: { authorization: `Bearer ${token()}` }, payload })).statusCode).toBe(400);
    }
    expect(withdraw).not.toHaveBeenCalled();
  });
  it('returns authenticated owner readback directly and never synthesizes missing evidence', async () => {
    const { app, read } = await mount();
    const request = { method: 'GET' as const, url: `${path}?tenantId=1&chargingCalloutRef=${ref}`, headers: { authorization: `Bearer ${token()}` } };
    expect((await app.inject(request)).statusCode).toBe(404);
    const stored = { coreEvidenceRef: 'core-withdrawal:original', requestHash: 'original', actorSubject: 'normal-adapter' };
    read.mockResolvedValue(stored);
    expect((await app.inject(request)).json()).toEqual(stored);
    expect(read).toHaveBeenLastCalledWith(1, ref, 'normal-adapter');
  });
});
