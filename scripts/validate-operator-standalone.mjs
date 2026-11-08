// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function operatorBuildCanaries() {
  return Object.fromEntries(
    [
      'OPERATOR_ADMIN_PASSWORD',
      'HASURA_ADMIN_SECRET',
      'OPERATOR_CORE_CLIENT_SECRET',
      'NEXTAUTH_SECRET',
    ].map((name) => [name, `synthetic-build-${randomBytes(24).toString('hex')}`]),
  );
}

export async function validateOperatorStandalone({ isolated, env, buildCanaries }) {
  let phase = 'fixture-start';
  let child;
  let childExit;
  let childError = false;
  let watchdog;
  let expired = false;
  let upstream;
  let reservation;
  const sockets = new Set();
  const pendingRequests = new Set();
  const secrets = [...Object.values(buildCanaries)];
  const canary = (name) => {
    const value = `synthetic-${name}-${randomBytes(24).toString('hex')}`;
    secrets.push(value);
    return value;
  };
  const password = canary('password');
  const adminSecret = canary('hasura');
  const clientSecret = canary('client');
  const sessionSecret = canary('session');
  const email = 'standalone-operator@example.invalid';
  const clientId = 'synthetic-operator';
  const fixtureErrors = [];
  const graphqlReceipts = [];
  const coreReceipts = [];
  const tokenReceipts = [];
  let tokenMode = 'wrong-audience';
  let fixtureOrigin;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const noSecrets = (text) => {
    assert.ok(
      secrets.every((secret) => !text.includes(secret)),
      `${phase}: secret canary escaped`,
    );
  };
  const reply = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const receive = async (request) => {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 300000, 'Fixture request exceeds bound');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(`http://127.0.0.1:${server.address().port}`);
      });
    });
  const request = async (origin, path, init = {}, jar = new Map()) => {
    assert.ok(
      !expired && !childError && child?.exitCode === null,
      `${phase}: owned server unavailable`,
    );
    const controller = new AbortController();
    pendingRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = new Headers(init.headers);
      if (jar.size)
        headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
      const response = await fetch(new URL(path, origin), {
        ...init,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0];
        const split = pair.indexOf('=');
        jar.set(pair.slice(0, split), pair.slice(split + 1));
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      try {
        if (reader) {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            assert.ok(size <= 4 * 1024 * 1024, `${phase}: browser response exceeds bound`);
            chunks.push(chunk.value);
          }
        }
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
      const text = Buffer.concat(chunks).toString('utf8');
      noSecrets(text);
      noSecrets(JSON.stringify([...response.headers]));
      return { status: response.status, headers: response.headers, text };
    } finally {
      clearTimeout(timer);
      pendingRequests.delete(controller);
    }
  };
  const closeServer = async (server) => {
    if (!server?.listening) return;
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  };
  const cancelOwned = () => {
    expired = true;
    for (const controller of pendingRequests) controller.abort();
    for (const socket of sockets) socket.destroy();
    // The handle belongs to our sole spawned child; never search or signal host PIDs.
    child?.kill('SIGKILL');
  };
  const onInterrupt = () => cancelOwned();
  const stopChild = async () => {
    if (!child || childError) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([
        childExit,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      try {
        await Promise.race([
          childExit,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Owned standalone process did not exit')),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  try {
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    watchdog = setTimeout(cancelOwned, 120000);
    upstream = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url, fixtureOrigin);
        if (url.pathname === '/v1/graphql') {
          const body = await receive(req);
          graphqlReceipts.push({ body, headers: req.headers });
          assert.ok(
            req.headers['x-hasura-admin-secret'] === adminSecret,
            'Missing server-only Hasura credential',
          );
          assert.equal(req.headers['x-hasura-role'], 'user');
          assert.equal(req.headers['x-hasura-tenant-id'], '7');
          assert.ok(
            !req.headers.cookie && !req.headers.authorization,
            'Browser credentials forwarded',
          );
          const operation = body.operationName;
          if (operation === 'ErrorFixture')
            return reply(res, 200, { errors: [{ message: adminSecret }] });
          if (operation === 'StatusErrorFixture') return reply(res, 503, { error: adminSecret });
          if (operation === 'SecretFixture')
            return reply(res, 200, { data: { secret: adminSecret } });
          if (operation === 'OversizeFixture')
            return reply(res, 200, { data: { value: 'x'.repeat(1048577) } });
          if (operation === 'SlowFixture') {
            // The application must abort its own 10-second upstream deadline.
            return;
          }
          if (operation === 'RedirectFixture') {
            res.writeHead(302, { location: `${fixtureOrigin}/redirect-target` });
            res.end();
            return;
          }
          const fields = {
            CreateFixture: 'insert_Locations_one',
            ReadFixture: 'Locations',
            UpdateFixture: 'update_Locations_by_pk',
            DeleteFixture: 'delete_Locations_by_pk',
          };
          assert.ok(fields[operation], 'Unexpected fixture operation');
          const row = { id: body.variables.id, name: body.variables.name ?? 'Synthetic row' };
          return reply(res, 200, {
            data: { [fields[operation]]: operation === 'ReadFixture' ? [row] : row },
          });
        }
        if (url.pathname === '/redirect-target') {
          fixtureErrors.push('Upstream redirect was followed');
          return reply(res, 200, { data: {} });
        }
        if (url.pathname === '/token') {
          const body = await receive(req);
          tokenReceipts.push(body);
          assert.ok(body.clientSecret === clientSecret, 'Machine secret mismatch');
          assert.ok(
            body.clientId === clientId &&
              body.coreTenantId === 7 &&
              body.audience === 'citrineos-core' &&
              body.scope === 'citrineos:operator:invoke' &&
              body.grantType === 'client_credentials',
            'Machine resource request mismatch',
          );
          const now = Math.floor(Date.now() / 1000);
          const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
          const input = `${encode({ alg: 'ES256', kid: 'synthetic-operator' })}.${encode({
            iss: fixtureOrigin,
            sub: clientId,
            actor_type: 'service',
            aud: tokenMode === 'wrong-audience' ? 'wrong-resource' : 'citrineos-core',
            core_tenant_id: 7,
            core_roles: ['evyar-operator'],
            scopes: ['citrineos:operator:invoke'],
            iat: now,
            exp: now + 300,
          })}`;
          const token = `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
          secrets.push(token);
          return reply(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 300 });
        }
        if (url.pathname === '/permissions/user') {
          const token = req.headers.authorization?.replace(/^Bearer /, '');
          const parts = token?.split('.') ?? [];
          assert.ok(
            parts.length === 3 &&
              verify(
                'sha256',
                Buffer.from(parts.slice(0, 2).join('.')),
                { key: publicKey, dsaEncoding: 'ieee-p1363' },
                Buffer.from(parts[2], 'base64url'),
              ),
            'Synthetic Core signature rejected',
          );
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          assert.ok(
            claims.aud === 'citrineos-core' &&
              claims.iss === fixtureOrigin &&
              claims.sub === clientId &&
              claims.core_tenant_id === 7 &&
              claims.core_roles[0] === 'evyar-operator',
            'Synthetic Core binding mismatch',
          );
          assert.equal(url.searchParams.get('tenantId'), '7');
          assert.ok(
            !req.headers.cookie && !req.headers['x-hasura-admin-secret'],
            'Core received browser/Hasura credentials',
          );
          coreReceipts.push({ tenantId: 7, role: 'evyar-operator' });
          return reply(res, 200, { fixture: 'synthetic-core-transport', permissions: [] });
        }
        reply(res, 404, { error: 'Unknown synthetic endpoint' });
      })().catch(() => {
        fixtureErrors.push('Synthetic upstream contract failed');
        if (!res.headersSent) reply(res, 500, { error: 'Fixture contract failed' });
        else res.destroy();
      });
    });
    upstream.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    upstream.requestTimeout = 15000;
    upstream.headersTimeout = 10000;
    fixtureOrigin = await listen(upstream);
    reservation = createServer();
    const origin = await listen(reservation);
    const port = new URL(origin).port;
    await closeServer(reservation);
    phase = 'standalone-start';
    assert.ok(!expired, 'Standalone validation cancelled');
    child = spawn(process.execPath, ['--max-old-space-size=256', 'server.js'], {
      cwd: join(isolated, 'apps/operator-ui'),
      env: {
        ...env,
        NODE_OPTIONS: '--max-old-space-size=256',
        HOSTNAME: '127.0.0.1',
        PORT: port,
        NEXTAUTH_URL: origin,
        NEXTAUTH_SECRET: sessionSecret,
        OPERATOR_ADMIN_EMAIL: email,
        OPERATOR_ADMIN_PASSWORD: password,
        OPERATOR_HASURA_URL: `${fixtureOrigin}/v1/graphql`,
        OPERATOR_HASURA_ROLE: 'user',
        HASURA_ADMIN_SECRET: adminSecret,
        OPERATOR_CORE_TENANT_ID: '7',
        // NextRequest normalizes numeric loopback hosts to localhost. Keep the
        // exact internal origin separate from the browser's public Origin.
        OPERATOR_REQUEST_ORIGIN: `http://localhost:${port}`,
        OPERATOR_CORE_URL: fixtureOrigin,
        OPERATOR_CORE_TOKEN_URL: `${fixtureOrigin}/token`,
        OPERATOR_CORE_CLIENT_ID: clientId,
        OPERATOR_CORE_CLIENT_SECRET: clientSecret,
        OPERATOR_CORE_ISSUER: fixtureOrigin,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    childExit = new Promise((resolve) => {
      child.once('error', () => {
        childError = true;
        resolve();
      });
      child.once('exit', resolve);
    });
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      assert.ok(
        !expired && !childError && child.exitCode === null && child.signalCode === null,
        'Standalone server exited before readiness',
      );
      try {
        const response = await fetch(`${origin}/api/auth/providers`, {
          signal: AbortSignal.timeout(500),
          redirect: 'manual',
        });
        ready = response.ok && Boolean((await response.json()).generic);
      } catch {
        /* The owned server may still be binding its socket. */
      }
      if (!ready) await delay(200);
    }
    assert.ok(ready, 'Standalone readiness deadline exceeded');
    phase = 'unauthenticated-denial';
    const bareGraph = await request(origin, '/api/graphql', { method: 'POST', body: '{}' });
    assert.ok(
      bareGraph.status === 401 ||
        ([302, 307].includes(bareGraph.status) &&
          new URL(bareGraph.headers.get('location'), origin).pathname === '/login'),
      'Unauthenticated GraphQL was not denied',
    );
    assert.equal((await request(origin, '/api/core/permissions/user')).status, 401);
    assert.equal(graphqlReceipts.length + tokenReceipts.length + coreReceipts.length, 0);
    const session = async (jar) =>
      JSON.parse((await request(origin, '/api/auth/session', {}, jar)).text);
    const login = async (jar, suppliedPassword, validCsrf = true) => {
      const csrf = JSON.parse((await request(origin, '/api/auth/csrf', {}, jar)).text).csrfToken;
      assert.ok(typeof csrf === 'string' && csrf.length > 20, 'Missing normal NextAuth CSRF token');
      return request(
        origin,
        '/api/auth/callback/generic',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
          body: new URLSearchParams({
            csrfToken: validCsrf ? csrf : 'invalid-csrf',
            username: email,
            password: suppliedPassword,
            callbackUrl: `${origin}/overview`,
            json: 'true',
          }).toString(),
        },
        jar,
      );
    };
    phase = 'nextauth-csrf-password-session';
    const badCsrf = new Map();
    await login(badCsrf, password, false);
    assert.ok(!(await session(badCsrf)).user, 'Invalid CSRF created a session');
    const wrong = new Map();
    assert.equal((await login(wrong, 'wrong-password')).status, 401);
    assert.ok(!(await session(wrong)).user, 'Wrong password created a session');
    const jar = new Map();
    const signedIn = await login(jar, password);
    assert.equal(signedIn.status, 200);
    assert.ok(
      signedIn.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.includes('session-token=') &&
            /httponly/i.test(cookie) &&
            /samesite=lax/i.test(cookie),
        ),
      'NextAuth session cookie lacks expected protections',
    );
    assert.ok(
      [...jar.keys()].some((key) => key.includes('session-token')),
      'NextAuth session cookie missing',
    );
    const authenticated = await session(jar);
    assert.ok(
      authenticated.user?.email === email && authenticated.user.roles.includes('admin'),
      'Normal NextAuth session missing identity/role',
    );
    phase = 'graphql-crud-transport';
    const graphql = (query, operationName, variables = {}, headers = {}) =>
      request(
        origin,
        '/api/graphql',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, ...headers },
          body: JSON.stringify({ query, operationName, variables }),
        },
        jar,
      );
    const operations = [
      ['CreateFixture', 'mutation', 'insert_Locations_one(object: {id: $id, name: $name})'],
      ['ReadFixture', 'query', 'Locations(where: {id: {_eq: $id}, name: {_eq: $name}})'],
      [
        'UpdateFixture',
        'mutation',
        'update_Locations_by_pk(pk_columns: {id: $id}, _set: {name: $name})',
      ],
      ['DeleteFixture', 'mutation', 'delete_Locations_by_pk(id: $id)'],
    ];
    for (const [name, kind, field] of operations) {
      const declaration = name === 'DeleteFixture' ? '$id: Int!' : '$id: Int!, $name: String!';
      const query = `${kind} ${name}(${declaration}) { ${field} { id name } }`;
      const variables =
        name === 'DeleteFixture'
          ? { id: 42 }
          : { id: 42, name: name === 'UpdateFixture' ? 'Updated synthetic row' : 'Synthetic row' };
      const response = await graphql(query, name, variables, {
        authorization: 'Bearer browser-sentinel',
      });
      phase = `graphql-crud-${name}-http-${response.status}-upstream-${graphqlReceipts.length}-fixture-errors-${fixtureErrors.length}`;
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const row = { id: variables.id, name: variables.name ?? 'Synthetic row' };
      assert.deepEqual(JSON.parse(response.text), {
        data: { [field.split('(')[0]]: name === 'ReadFixture' ? [row] : row },
      });
      assert.deepEqual(graphqlReceipts.at(-1).body, { query, operationName: name, variables });
    }
    phase = 'graphql-request-boundaries';
    const beforeRejected = graphqlReceipts.length;
    const query = 'query BoundaryFixture { Locations { id } }';
    for (const headers of [
      { 'x-hasura-tenant-id': '99' },
      { 'x-hasura-role': 'admin' },
      { 'x-hasura-admin-secret': 'browser-secret' },
    ]) {
      assert.equal((await graphql(query, 'BoundaryFixture', {}, headers)).status, 400);
    }
    assert.equal(
      (await graphql(query, 'BoundaryFixture', {}, { origin: 'http://cross-origin.invalid' }))
        .status,
      403,
    );
    assert.equal(
      (await graphql(query, 'BoundaryFixture', {}, { 'sec-fetch-site': 'cross-site' })).status,
      403,
    );
    assert.equal(
      (
        await request(
          origin,
          '/api/graphql',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query }),
          },
          jar,
        )
      ).status,
      403,
    );
    assert.equal(
      (await graphql(query, 'BoundaryFixture', { value: 'x'.repeat(262145) })).status,
      502,
    );
    assert.equal(
      graphqlReceipts.length,
      beforeRejected,
      'Rejected request reached synthetic upstream',
    );
    phase = 'graphql-bounded-upstream-failures';
    for (const operation of [
      'ErrorFixture',
      'StatusErrorFixture',
      'SecretFixture',
      'OversizeFixture',
      'RedirectFixture',
      'SlowFixture',
    ]) {
      phase = `graphql-upstream-${operation}`;
      const before = graphqlReceipts.length;
      const started = Date.now();
      const response = await graphql(`query ${operation} { Locations { id } }`, operation);
      assert.equal(response.status, 502, `${operation}: upstream failure was not bounded`);
      assert.equal(
        graphqlReceipts.length,
        before + 1,
        'Failure probe did not reach synthetic upstream',
      );
      assert.ok(
        response.text.length < 1024 && Date.now() - started < 14000,
        'Upstream failure exceeded response/time bound',
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    phase = 'core-route-machine-resource-binding';
    assert.equal(
      (await request(origin, '/api/core/permissions/user', { headers: { origin } }, jar)).status,
      502,
    );
    assert.equal(coreReceipts.length, 0, 'Wrong-audience token reached Core fixture');
    tokenMode = 'valid';
    const core = await request(origin, '/api/core/permissions/user', { headers: { origin } }, jar);
    assert.equal(core.status, 200);
    assert.equal(JSON.parse(core.text).fixture, 'synthetic-core-transport');
    assert.equal(coreReceipts.length, 1);
    assert.equal(
      (
        await request(
          origin,
          '/api/core/permissions/user?tenantId=99',
          { headers: { origin } },
          jar,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          origin,
          '/api/core/permissions/user',
          { headers: { origin: 'http://cross-origin.invalid' } },
          jar,
        )
      ).status,
      403,
    );
    assert.equal(coreReceipts.length, 1);
    phase = 'browser-public-artifacts';
    const loginPage = await request(origin, '/login');
    assert.equal(loginPage.status, 200);
    let publicFiles = 0;
    let staticPath;
    const scan = (directory, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        assert.ok(!entry.isSymbolicLink(), 'Public artifact contains an unexpected symlink');
        if (entry.isDirectory()) scan(file, `${prefix}${entry.name}/`);
        else if (/\.(?:js|json|map|html|txt)$/.test(entry.name)) {
          noSecrets(readFileSync(file, 'utf8'));
          publicFiles += 1;
          if (!staticPath && entry.name.endsWith('.js')) staticPath = `${prefix}${entry.name}`;
        }
      }
    };
    scan(join(isolated, 'apps/operator-ui/.next/static'));
    scan(join(isolated, 'apps/operator-ui/public'));
    assert.ok(publicFiles > 0 && staticPath, 'No public chunks inspected');
    assert.equal((await request(origin, `/_next/static/${staticPath}`)).status, 200);
    assert.equal(fixtureErrors.length, 0, 'Synthetic upstream contract failed');
    assert.ok(!expired, 'Standalone validation cancelled');
    return {
      status: 'PASS',
      profile: 'actual-next-standalone-synthetic-loopback',
      nextAuth: {
        csrf: true,
        invalidCsrfDenied: true,
        wrongPasswordDenied: true,
        cookieSession: true,
      },
      unauthenticatedGraphqlStatus: bareGraph.status,
      graphql: {
        crudTransportOperations: 4,
        fixedTenant: 7,
        fixedRole: 'user',
        headerOverrideDenied: true,
        crossOriginDenied: true,
        upstreamFailureCases: 6,
        publicFilesScanned: publicFiles,
      },
      core: {
        actualNextRoute: true,
        sharedMachineTokenBinding: true,
        signedSyntheticUpstream: true,
        actualCoreServerJwtAcceptance: false,
      },
      realDatabaseCrud: false,
      realHasuraAuthorization: false,
      browserAutomation: false,
      serverHeapMiB: 256,
      deploymentPerformed: false,
      harnessSha256: createHash('sha256')
        .update(readFileSync(new URL(import.meta.url)))
        .digest('hex'),
    };
  } catch {
    // Avoid assertion diffs, credentials, cookies and child output in hosted logs.
    throw new Error(`Isolated standalone transport failed during ${phase}`);
  } finally {
    clearTimeout(watchdog);
    for (const controller of pendingRequests) controller.abort();
    for (const socket of sockets) socket.destroy();
    const cleanup = await Promise.allSettled([
      stopChild(),
      closeServer(upstream),
      closeServer(reservation),
    ]);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    assert.ok(
      cleanup.every((result) => result.status === 'fulfilled'),
      'Owned standalone fixture cleanup failed',
    );
  }
}
