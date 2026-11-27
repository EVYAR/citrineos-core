// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ResourceType } from '@lib/utils/access-types';
import { createOperatorQueryClient } from './query-client';

describe('Operator Hasura polling defaults', () => {
  it('polls known Hasura read families only in the foreground', () => {
    const client = createOperatorQueryClient('generic');
    for (const resource of [...Object.values(ResourceType), 'ChangeConfigurations']) {
      for (const suffix of [
        ['list', { filters: [], pagination: { currentPage: 1, pageSize: 10 } }],
        ['one', '7', {}],
        ['many', ['7', '8'], {}],
        ['infinite', { filters: [], pagination: { pageSize: 10 } }],
      ]) {
        const queryKey = ['data', 'default', resource, ...suffix];
        expect(client.defaultQueryOptions({ queryKey })).toMatchObject({
          staleTime: 5000,
          refetchInterval: 5000,
          refetchIntervalInBackground: false,
          retry: false,
        });
      }
    }
  });

  const unrelatedKeys: readonly (readonly unknown[])[] = [
    ['permissions', 'user'],
    ['auth', 'permissions'],
    ['access', 'Locations', 'list'],
    ['useCan', 'ChargingStations', 'show', '7'],
    ['dev', 'roles'],
    ['maps', 'Locations'],
    ['data', 'default', 'custom', { method: 'get', url: '/api/maps' }],
    ['data', 'default', 'custom', { method: 'get', url: '/api/files/firmware' }],
    ['data', 'default', 'custom', { method: 'post', url: '/api/graphql' }],
    ['data', 'default', 'https://core.test/Locations', 'list'],
    ['data', 'default', 'Unknown', 'list'],
    ['data', 'other', 'Locations', 'list'],
    ['data', 'default', 'Locations', 'create'],
    ['data', 'default', 'Locations'],
    [],
  ];

  it.each(unrelatedKeys.map((queryKey) => ({ queryKey })))(
    'leaves unrelated query defaults unchanged: $queryKey',
    ({ queryKey }) => {
      const client = createOperatorQueryClient('generic');
      const baseline = createOperatorQueryClient('keycloak');
      const options = client.defaultQueryOptions({ queryKey });
      const original = baseline.defaultQueryOptions({ queryKey });
      expect(options.refetchInterval).toBe(false);
      expect(options.staleTime).toBe(original.staleTime);
      expect(options.retry).toBe(original.retry);
    },
  );

  it('preserves Keycloak defaults for Hasura reads', () => {
    const client = createOperatorQueryClient('keycloak');
    const options = client.defaultQueryOptions({
      queryKey: ['data', 'default', 'ChargingStations', 'one', '7', {}],
    });
    expect(options.refetchInterval).toBe(false);
    expect(options.staleTime).toBe(Infinity);
    expect(options.retry).toBeUndefined();
  });
});
