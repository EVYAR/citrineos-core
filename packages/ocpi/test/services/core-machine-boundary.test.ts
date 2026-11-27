// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';
import { Ajv } from 'ajv';
import { Logger, type ILogObj } from 'tslog';
import { describe, expect, it, vi } from 'vitest';
import { OCPPVersion } from '@citrineos/types';
import type { TenantPartnerDto } from '@citrineos/types';
import { ocpiConfigSchema } from '@ocpi/config/ocpi-types.js';
import { OCPPCommandHandler } from '@ocpi/services/ocpp-command-handlers/base.js';
import { OcpiEmptyResponseSchema } from '@ocpi/types/ocpi-empty-response.js';
import type { CommandsClientApi } from '@ocpi/transport/trigger/commands-client-api.js';

function config(coreHeaders: Record<string, string> = {}) {
  const urls = {
    remoteStartTransactionRequestUrl: 'https://core.test/start',
    remoteStopTransactionRequestUrl: 'https://core.test/stop',
    unlockConnectorRequestUrl: 'https://core.test/unlock',
  };
  const urls2 = {
    requestStartTransactionRequestUrl: urls.remoteStartTransactionRequestUrl,
    requestStopTransactionRequestUrl: urls.remoteStopTransactionRequestUrl,
    unlockConnectorRequestUrl: urls.unlockConnectorRequestUrl,
  };
  return ocpiConfigSchema.parse({
    env: 'development',
    ocpiServer: { host: 'localhost', port: 8085 },
    ocpiModules: {},
    database: {
      host: 'localhost',
      port: 5432,
      database: 'unused',
      username: 'unused',
      password: '',
    },
    cache: { memory: true },
    graphql: { endpoint: 'https://graphql.invalid' },
    logLevel: 6,
    defaultPageLimit: 50,
    maxPageLimit: 1000,
    commands: {
      timeout: 30,
      ocpiBaseUrl: 'https://ocpi.test',
      coreHeaders,
      coreAuth: {
        tokenUrl: 'https://iam.test/token',
        coreUrl: 'https://core.test',
        clientId: 'ocpi-only',
        clientSecret: 'test-only-secret',
        issuer: 'https://iam.test',
      },
      ocpp1_6: urls,
      ocpp2_0_1: urls2,
      ocpp2_1: urls2,
    },
  });
}
const partner: TenantPartnerDto = {
  id: 1,
  tenantId: 7,
  partnerProfileOCPI: {
    version: { version: '2.2.1' },
    serverCredentials: { versionsUrl: 'https://partner.test' },
  },
};
class Handler extends OCPPCommandHandler {
  readonly supportedVersion = OCPPVersion.OCPP1_6;
  async sendStartSessionCommand(): Promise<void> {}
  async sendStopSessionCommand(): Promise<void> {}
  async sendUnlockConnectorCommand(): Promise<void> {}
  async handleAsyncCommandResponse(): Promise<void> {}
  send(caller: TenantPartnerDto = partner): Promise<void> {
    return this.sendOCPPMessage(
      'https://core.test/start',
      { idTag: 'TOKEN' },
      { queryParameters: { params: { tenantId: 7, identifier: 'cp001' } } },
      caller,
      'https://partner.test/callback',
      'command1',
    );
  }
}
function build(headers: Record<string, string> = {}) {
  const postCommandResult = vi
    .fn<CommandsClientApi['postCommandResult']>()
    .mockResolvedValue(OcpiEmptyResponseSchema.parse({ status_code: 1000, timestamp: new Date() }));
  const logger = new Logger<ILogObj>({ type: 'hidden' });
  const debug = vi.spyOn(logger, 'debug');
  const handler = new Handler({
    config: config(headers),
    logger,
    ajv: new Ajv(),
    commandsClientApi: { postCommandResult },
    ocpiGraphqlClient: {
      request: async () => {
        throw new Error('Unexpected GraphQL');
      },
    },
  });
  return { handler, postCommandResult, debug };
}
function token(tenant: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', kid: 'key' })}.${encode({ iss: 'https://iam.test', aud: 'citrineos-core', sub: 'ocpi-only', actor_type: 'service', core_tenant_id: tenant, core_roles: ['evyar-ocpi'], scopes: ['citrineos:ocpi:invoke'], exp: Math.floor(Date.now() / 1000) + 300 })}.signature`;
}

describe('OCPI Core machine boundary', () => {
  it('attaches a just-in-time tenant token and keeps request options out of logs', async () => {
    const issuedToken = token(7);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === 'https://iam.test/token')
        return Response.json({ access_token: issuedToken, token_type: 'Bearer', expires_in: 300 });
      if (String(url) !== 'https://core.test/start?tenantId=7&identifier=cp001')
        throw new Error('Unexpected network');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${issuedToken}`);
      return Response.json([{ success: true }]);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const { handler, postCommandResult, debug } = build();
      await handler.send();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(postCommandResult).not.toHaveBeenCalled();
      expect(JSON.stringify(debug.mock.calls)).not.toContain('test-only-secret');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('authorization');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses static Authorization and a contradictory tenant without network calls', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('Unexpected network');
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(() => build({ Authorization: 'Bearer old-token' })).toThrow('Static Core credentials');
      const { handler, postCommandResult } = build();
      await handler.send({ ...partner, tenantId: 8 });
      expect(fetcher).not.toHaveBeenCalled();
      expect(postCommandResult).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
