// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { authProvider } from '@lib/providers/auth-provider';
import config from '@lib/utils/config';
import { HasuraHeader } from '@lib/utils/hasura-types';
import dataProviderHasura, {
  GraphQLClient,
  type HasuraDataProviderOptions,
} from '@refinedev/hasura';

const API_URL = config.apiUrl;

const client = new GraphQLClient(API_URL, {
  credentials: 'same-origin',
  requestMiddleware: async (request) => {
    if (config.authProvider === 'generic') return request;
    const token = await authProvider.getToken();
    if (!token) throw new Error('Hasura user session required');
    const headers = new Headers();
    if (Array.isArray(request.headers)) {
      request.headers.forEach((pair) => {
        const [name, value] = pair;
        if (pair.length !== 2 || typeof name !== 'string' || typeof value !== 'string') {
          throw new Error('Invalid GraphQL request headers');
        }
        headers.append(name, value);
      });
    } else if (request.headers) {
      if (typeof request.headers.forEach === 'function') {
        request.headers.forEach((value: string, name: string) => headers.append(name, value));
      } else {
        Object.entries(request.headers).forEach(([name, value]) => {
          if (typeof value !== 'string') throw new Error('Invalid GraphQL request headers');
          headers.append(name, value);
        });
      }
    }
    headers.set('Authorization', `Bearer ${token}`);
    const role = (await authProvider.getHasuraHeaders()).get(HasuraHeader.X_HASURA_ROLE);
    if (role) headers.set(HasuraHeader.X_HASURA_ROLE, role);
    return { ...request, headers };
  },
});

const hasuraProviderOptions = {
  idType: 'Int',
  namingConvention: 'hasura-default',
};

const dataProvider = dataProviderHasura(client, hasuraProviderOptions as HasuraDataProviderOptions);

dataProvider.getApiUrl = () => {
  return API_URL;
};

export default dataProvider;
