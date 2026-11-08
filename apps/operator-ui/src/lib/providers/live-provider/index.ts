// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use client';

import { authProvider } from '@lib/providers/auth-provider';
import config from '@lib/utils/config';
import { HasuraHeader } from '@lib/utils/hasura-types';
import {
  graphqlWS,
  type HasuraLiveProviderOptions,
  liveProvider as liveProviderHasura,
} from '@refinedev/hasura';

const WS_URL = config.wsUrl;

function createUserLiveProvider() {
  const webSocketClient = graphqlWS.createClient({
    url: WS_URL,
    connectionParams: async () => {
      const token = await authProvider.getToken();
      if (!token) throw new Error('Hasura user session required');
      const hasuraHeaders = await authProvider.getHasuraHeaders();
      const role = hasuraHeaders.get(HasuraHeader.X_HASURA_ROLE);
      return {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(role ? { [HasuraHeader.X_HASURA_ROLE]: role } : {}),
        },
      };
    },
  });

  const hasuraProviderOptions = {
    idType: 'Int',
    namingConvention: 'hasura-default',
  };

  return liveProviderHasura(webSocketClient, hasuraProviderOptions as HasuraLiveProviderOptions);
}

const liveProvider = config.authProvider === 'keycloak' ? createUserLiveProvider() : undefined;

export default liveProvider;
