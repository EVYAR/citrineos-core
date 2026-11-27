// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ocpiAdminAuth } from '../../../../apps/ocpi-server/src/config/envs/admin-auth.js';
import { createDockerOcpiConfig } from '../../../../apps/ocpi-server/src/config/envs/docker.js';
import { createLocalOcpiConfig } from '../../../../apps/ocpi-server/src/config/envs/local.js';
import { oidcConfigSchema } from '@ocpi/config/ocpi-types.js';

const env = {
  OCPI_ADMIN_JWKS_URI: 'https://issuer.test/jwks',
  OCPI_ADMIN_ISSUER: 'https://issuer.test',
  OCPI_ADMIN_AUDIENCE: 'ocpi-admin',
  OCPI_ADMIN_ALLOWED_SUBJECTS: 'operator-one,operator-two',
};
afterEach(() => vi.unstubAllEnvs());

describe('explicit optional admin configuration', () => {
  it('has no implicit issuer, audience or trusted subjects', () => {
    expect(ocpiAdminAuth({})).toBeUndefined();
  });
  it.each(Object.keys(env))('rejects a missing %s without reflecting configuration', (key) => {
    expect(() => ocpiAdminAuth({ ...env, [key]: '' })).toThrow(
      'Complete OCPI_ADMIN configuration is required',
    );
  });
  it.each(['', ',', 'subject,', ' ,subject'])('rejects an empty subject member %j', (subjects) => {
    expect(() => ocpiAdminAuth({ ...env, OCPI_ADMIN_ALLOWED_SUBJECTS: subjects })).toThrow();
  });
  it('requires issuer, audience and nonempty trusted subjects in the config schema', () => {
    expect(
      oidcConfigSchema.safeParse({
        jwksUri: env.OCPI_ADMIN_JWKS_URI,
        issuer: env.OCPI_ADMIN_ISSUER,
      }).success,
    ).toBe(false);
    expect(
      oidcConfigSchema.safeParse({
        jwksUri: env.OCPI_ADMIN_JWKS_URI,
        issuer: env.OCPI_ADMIN_ISSUER,
        audience: 'ocpi-admin',
        allowedSubjects: [],
      }).success,
    ).toBe(false);
  });
  it.each([createLocalOcpiConfig, createDockerOcpiConfig])(
    'wires the complete config into %s',
    (factory) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      expect(factory().oidc).toEqual({
        jwksUri: env.OCPI_ADMIN_JWKS_URI,
        issuer: env.OCPI_ADMIN_ISSUER,
        audience: 'ocpi-admin',
        allowedSubjects: ['operator-one', 'operator-two'],
      });
    },
  );
});
