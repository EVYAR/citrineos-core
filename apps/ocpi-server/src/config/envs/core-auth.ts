// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { OcpiConfigInput } from '@citrineos/ocpi';

export function ocpiCoreAuth(env: NodeJS.ProcessEnv): OcpiConfigInput['commands']['coreAuth'] {
  if (!env.OCPI_CORE_TOKEN_URL) return undefined;
  return {
    tokenUrl: env.OCPI_CORE_TOKEN_URL,
    coreUrl: env.OCPI_CORE_URL || '',
    clientId: env.OCPI_CORE_CLIENT_ID || '',
    clientSecret: env.OCPI_CORE_CLIENT_SECRET || '',
    issuer: env.OCPI_CORE_ISSUER || '',
    timeoutMs: Number(env.OCPI_CORE_AUTH_TIMEOUT_MS || '5000'),
  };
}
