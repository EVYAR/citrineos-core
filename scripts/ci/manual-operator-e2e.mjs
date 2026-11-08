// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
// Synthetic hosted fixture only. Invoked under bounded.py; never reads deployment credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const state = resolve(root, 'reports/ci/operator-e2e.private.json');
const mode = process.argv[2];
assert.ok(['prepare', 'build', 'run'].includes(mode));
const secret = () => randomBytes(32).toString('hex');
if (mode === 'prepare') {
  writeFileSync(
    state,
    JSON.stringify({
      password: secret(),
      hasura: secret(),
      session: secret(),
      machine: secret(),
      database: secret(),
    }),
    { flag: 'wx', mode: 0o600 },
  );
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(state, 'utf8'));
const env = { ...process.env };
for (const name of readdirSync(resolve(root, 'apps/operator-ui')).filter((name) =>
  /^\.env(?:\.|$)/.test(name),
)) {
  for (const line of readFileSync(resolve(root, 'apps/operator-ui', name), 'utf8').split(/\r?\n/)) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key) env[key] = '';
  }
}
Object.assign(env, {
  NODE_ENV: 'production',
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  NEXT_PUBLIC_AUTH_PROVIDER: 'generic',
  NEXT_PUBLIC_CORE_TRANSPORT: 'server',
  NEXT_PUBLIC_TENANT_ID: '1',
  NEXTAUTH_URL: 'http://127.0.0.1:3000',
  NEXTAUTH_SECRET: fixture.session,
  OPERATOR_ADMIN_EMAIL: 'ci-operator@example.invalid',
  OPERATOR_ADMIN_PASSWORD: fixture.password,
  OPERATOR_HASURA_URL: 'http://127.0.0.1:8090/v1/graphql',
  OPERATOR_HASURA_ROLE: 'user',
  HASURA_ADMIN_SECRET: fixture.hasura,
  OPERATOR_CORE_TENANT_ID: '1',
  OPERATOR_REQUEST_ORIGIN: 'http://localhost:3000',
  OPERATOR_CORE_URL: 'http://127.0.0.1:8080',
  OPERATOR_CORE_TOKEN_URL: 'http://127.0.0.1:18001/token',
  OPERATOR_CORE_CLIENT_ID: 'ci-operator',
  OPERATOR_CORE_CLIENT_SECRET: fixture.machine,
  OPERATOR_CORE_ISSUER: 'http://127.0.0.1:18001',
  E2E_BASE_URL: 'http://127.0.0.1:3000',
  HASURA_URL: 'http://127.0.0.1:8090/v1/graphql',
  CITRINE_CORE_URL: 'http://127.0.0.1:8080',
  E2E_ADMIN_EMAIL: 'ci-operator@example.invalid',
  E2E_ADMIN_PASSWORD: fixture.password,
  E2E_TENANT_ID: '1',
  E2E_AUTH_PROVIDER: 'generic',
  E2E_SKIP_BUILD: '1',
  E2E_WORKERS: '1',
  ALLOW_IMAGE_UPLOAD: 'false',
});
let phase = mode;
const children = new Set();
function child(command, args, cwd = root, extra = {}) {
  const proc = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: 'ignore' });
  children.add(proc);
  const exit = new Promise((done) => {
    proc.once('error', () => {
      children.delete(proc);
      done({ code: 1, signal: null });
    });
    proc.once('exit', (code, signal) => {
      children.delete(proc);
      done({ code, signal });
    });
  });
  return { proc, exit };
}
async function checked(command, args, cwd, extra) {
  const result = await child(command, args, cwd, extra).exit;
  assert.ok(result.code === 0 && !result.signal, `Synthetic fixture failed at ${phase}`);
}
let issuer;
try {
  if (mode === 'build') {
    await checked(
      'pnpm',
      ['--workspace-concurrency=1', '--filter', '@citrineos/operator-ui...', 'run', 'build'],
      root,
      { NODE_OPTIONS: '--max-old-space-size=4096' },
    );
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: 'ci-synthetic',
      alg: 'ES256',
      use: 'sig',
    };
    issuer = createServer((request, response) => {
      void (async () => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/.well-known/jwks.json')
          return response.end(JSON.stringify({ keys: [jwk] }));
        assert.ok(request.url === '/token' && request.method === 'POST');
        let body = '';
        for await (const part of request) {
          body += part;
          assert.ok(body.length < 8192);
        }
        const input = JSON.parse(body);
        assert.ok(
          input.grantType === 'client_credentials' &&
            input.clientId === 'ci-operator' &&
            input.clientSecret === fixture.machine &&
            input.coreTenantId === 1 &&
            input.audience === 'citrineos-core' &&
            input.scope === 'citrineos:operator:invoke',
        );
        const now = Math.floor(Date.now() / 1000);
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const data = `${encode({ alg: 'ES256', kid: jwk.kid })}.${encode({ iss: env.OPERATOR_CORE_ISSUER, sub: 'ci-operator', actor_type: 'service', aud: 'citrineos-core', core_tenant_id: 1, core_roles: ['evyar-operator'], scopes: ['citrineos:operator:invoke'], iat: now, exp: now + 300 })}`;
        const token = `${data}.${sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
        response.end(
          JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 300 }),
        );
      })().catch(() => {
        response.statusCode = 403;
        response.end('{"error":"Synthetic request rejected"}');
      });
    });
    await new Promise((done, fail) => {
      issuer.once('error', fail);
      issuer.listen(18001, '0.0.0.0', done);
    });
    const override = {
      services: {
        'ocpp-db': { environment: { POSTGRES_PASSWORD: fixture.database } },
        'graphql-engine': {
          environment: {
            HASURA_GRAPHQL_ADMIN_SECRET: fixture.hasura,
            HASURA_GRAPHQL_DATABASE_URL: `postgres://citrine:${fixture.database}@ocpp-db:5432/citrine`,
          },
        },
        citrine: {
          pull_policy: 'never',
          extra_hosts: ['host.docker.internal:host-gateway'],
          environment: {
            CITRINEOS_DATABASE_PASSWORD: fixture.database,
            CITRINEOS_AUTH_MODE: 'jwt',
            CITRINEOS_AUTH_JWT_JWKSURI: 'http://host.docker.internal:18001/.well-known/jwks.json',
            CITRINEOS_AUTH_JWT_ISSUER: env.OPERATOR_CORE_ISSUER,
            CITRINEOS_AUTH_JWT_AUDIENCE: 'citrineos-core',
            CITRINEOS_AUTH_JWT_TENANTCLAIM: 'core_tenant_id',
            CITRINEOS_AUTH_JWT_ROLESCLAIM: 'core_roles',
            CITRINEOS_AUTH_JWT_REQUIREDTENANTCLAIM: 'true',
            CITRINEOS_INTEGRATIONS_V2GCA: '',
            CITRINEOS_INTEGRATIONS_CHARGINGSTATIONCA: '',
          },
        },
      },
    };
    const file = resolve(root, 'reports/ci/operator-compose.private.json');
    writeFileSync(file, JSON.stringify(override), { flag: 'wx', mode: 0o600 });
    phase = 'current-monorepo-backend';
    await checked('docker', [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.local.yml',
      '-f',
      file,
      'up',
      '-d',
      '--build',
      'ocpp-db',
      'amqp-broker',
      'graphql-engine',
      'citrine',
    ]);
    const standalone = resolve(root, 'apps/operator-ui/.next/standalone/apps/operator-ui');
    cpSync(resolve(root, 'apps/operator-ui/.next/static'), resolve(standalone, '.next/static'), {
      recursive: true,
    });
    cpSync(resolve(root, 'apps/operator-ui/public'), resolve(standalone, 'public'), {
      recursive: true,
    });
    child(process.execPath, ['--max-old-space-size=512', 'server.js'], standalone, {
      HOSTNAME: '127.0.0.1',
      PORT: '3000',
      NODE_OPTIONS: '--max-old-space-size=512',
    });
    phase = 'loopback-readiness';
    for (const endpoint of [
      'http://127.0.0.1:8080/health',
      'http://127.0.0.1:8090/healthz',
      'http://127.0.0.1:3000/login',
    ]) {
      let ready = false;
      for (let attempt = 0; attempt < 90 && !ready; attempt++) {
        try {
          const response = await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
          ready = response.ok;
          await response.body?.cancel();
        } catch {
          /* Bounded readiness only. */
        }
        if (!ready) await delay(1000);
      }
      assert.ok(ready, 'Synthetic loopback service did not become ready');
    }
    const everest = process.argv[3] === 'everest';
    if (everest) {
      phase = 'simulated-everest';
      await checked(
        'pnpm',
        ['--filter', '@citrineos/ocpp-server', 'run', 'start:everest:ws'],
        root,
        {
          OCPP_VERSION: '2.1',
        },
      );
    }
    phase = 'actual-playwright';
    await checked(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        `--project=${everest ? 'everest-serial' : 'chromium-desktop'}`,
        '--workers=1',
        '--retries=0',
      ],
      resolve(root, 'apps/operator-ui'),
    );
    writeFileSync(
      resolve(root, 'reports/ci/manual-e2e-result.json'),
      JSON.stringify({
        status: 'PASS',
        fixture: 'synthetic-hosted-jwks',
        everest,
        realIam: false,
        physicalCharger: false,
        credentialFingerprint: createHash('sha256').update(fixture.machine).digest('hex'),
      }) + '\n',
    );
  }
} catch {
  console.error(
    `Synthetic manual Operator fixture failed at ${phase}; no credentials or child output emitted`,
  );
  process.exitCode = 1;
} finally {
  for (const proc of children) proc.kill('SIGTERM');
  issuer?.closeAllConnections();
  if (issuer) await new Promise((done) => issuer.close(done));
}
