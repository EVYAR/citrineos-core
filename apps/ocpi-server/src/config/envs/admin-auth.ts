// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { OcpiConfigInput } from '@citrineos/ocpi';

export function ocpiAdminAuth(env: NodeJS.ProcessEnv): OcpiConfigInput['oidc'] {
  const values = [
    env.OCPI_ADMIN_JWKS_URI,
    env.OCPI_ADMIN_ISSUER,
    env.OCPI_ADMIN_AUDIENCE,
    env.OCPI_ADMIN_ALLOWED_SUBJECTS,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => !value?.trim())) {
    throw new Error('Complete OCPI_ADMIN configuration is required');
  }
  const allowedSubjects = env.OCPI_ADMIN_ALLOWED_SUBJECTS!.split(',').map((value) => value.trim());
  if (allowedSubjects.some((value) => !value)) throw new Error('Invalid OCPI_ADMIN subjects');
  const jwksUri = new URL(env.OCPI_ADMIN_JWKS_URI!);
  const issuer = new URL(env.OCPI_ADMIN_ISSUER!);
  if (
    jwksUri.protocol !== 'https:' ||
    issuer.protocol !== 'https:' ||
    jwksUri.username ||
    jwksUri.password ||
    issuer.username ||
    issuer.password
  ) {
    throw new Error('OCPI_ADMIN issuer and JWKS must use HTTPS without credentials');
  }
  return {
    jwksUri: jwksUri.href,
    issuer: env.OCPI_ADMIN_ISSUER!,
    audience: env.OCPI_ADMIN_AUDIENCE!.trim(),
    allowedSubjects,
  };
}
