// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Operator GraphQL profile selection', () => {
  it('routes generic custom queries and CRUD to the same-origin proxy without a secret', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDER', 'generic');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://direct-hasura.test/v1/graphql');
    vi.stubEnv('HASURA_ADMIN_SECRET', 'server-private-key');
    const { default: config } = await import('./config');
    expect(config.apiUrl).toBe('/api/graphql');
    expect(config).not.toHaveProperty('hasuraAdminSecret');
    expect(JSON.stringify(config)).not.toContain('server-private-key');
  });

  it('retains the separately configured Keycloak HTTP and WebSocket endpoints', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDER', 'keycloak');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://user-hasura.test/v1/graphql');
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://user-hasura.test/v1/graphql');
    const { default: config } = await import('./config');
    expect(config.apiUrl).toBe('https://user-hasura.test/v1/graphql');
    expect(config.wsUrl).toBe('wss://user-hasura.test/v1/graphql');
  });
});
