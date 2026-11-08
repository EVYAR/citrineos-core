// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ResourceType } from '@lib/utils/access-types';
import { QueryClient } from '@tanstack/react-query';

export function createOperatorQueryClient(authProvider: string): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        refetchInterval: false,
        refetchOnWindowFocus: false,
      },
    },
  });

  if (authProvider === 'generic') {
    // Refine 5 keys: ['data', provider, resource, action, ...parameters].
    for (const resource of [...Object.values(ResourceType), 'ChangeConfigurations']) {
      for (const action of ['list', 'one', 'many', 'infinite']) {
        client.setQueryDefaults(['data', 'default', resource, action], {
          staleTime: 5000,
          refetchInterval: 5000,
          refetchIntervalInBackground: false,
          retry: false,
        });
      }
    }
  }

  return client;
}
