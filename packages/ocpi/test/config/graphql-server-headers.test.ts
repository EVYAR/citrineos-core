// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ocpiGraphqlHeaders } from '../../../../apps/ocpi-server/src/config/envs/graphql-headers.js';
import { createDockerOcpiConfig } from '../../../../apps/ocpi-server/src/config/envs/docker.js';
import { createLocalOcpiConfig } from '../../../../apps/ocpi-server/src/config/envs/local.js';

afterEach(() => vi.unstubAllEnvs());

describe('explicit OCPI GraphQL service headers', () => {
  it.each([
    'invalid-secret',
    '[]',
    'null',
    '{"authorization":4}',
    '{"authorization":["secret"]}',
    '{"x-secret":"bad\\r\\nheader"}',
    '{"Authorization":"a","authorization":"b"}',
  ])('rejects malformed header input without reflecting its value', (input) => {
    expect(() => ocpiGraphqlHeaders(input)).toThrow(
      'OCPI_GRAPHQL_HEADERS must be a JSON object of valid string headers',
    );
  });

  it('does not invent credentials, tenant IDs or roles when absent', () => {
    expect(ocpiGraphqlHeaders(undefined)).toBeUndefined();
    expect(ocpiGraphqlHeaders('{}')).toEqual({});
  });

  it.each([createDockerOcpiConfig, createLocalOcpiConfig])(
    'preserves only explicitly supplied Hasura headers, separate from Core credentials',
    (createConfig) => {
      vi.stubEnv('OCPI_GRAPHQL_HEADERS', '{"x-hasura-admin-secret":"test-only-hasura-secret"}');
      vi.stubEnv('COMMANDS_CORE_HEADERS', '{"x-correlation-id":"core-only"}');
      const config = createConfig();
      expect(config.graphql.headers).toEqual({
        'x-hasura-admin-secret': 'test-only-hasura-secret',
      });
      expect(config.graphql.headers).not.toHaveProperty('x-hasura-tenant-id');
      expect(config.graphql.headers).not.toHaveProperty('x-hasura-role');
      expect(config.commands.coreHeaders).toEqual({ 'x-correlation-id': 'core-only' });
      expect(config.commands.coreHeaders).not.toHaveProperty('x-hasura-admin-secret');
    },
  );
});
