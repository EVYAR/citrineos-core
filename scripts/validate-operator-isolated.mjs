// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
// Build-only acceptance. Never starts an application or supplies live credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'apps/operator-ui');
const heap = process.argv[2] ?? '1536';
assert.ok(['1536', '2048', '4096'].includes(heap), 'Explicit supported Node heap required');
assert.match(process.version, /^v24\./);
const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  CI: 'true',
  TZ: 'UTC',
  LANG: 'C.UTF-8',
  NODE_ENV: 'production',
  NODE_OPTIONS: `--max-old-space-size=${heap}`,
  NEXT_TELEMETRY_DISABLED: '1',
  RAYON_NUM_THREADS: '1',
  TOKIO_WORKER_THREADS: '1',
};
// Next also loads checked-in sample env files. Override their keys without
// reading their values into the build's environment or printing them.
for (const name of readdirSync(app).filter((name) => /^\.env(?:\.|$)/.test(name))) {
  for (const line of readFileSync(resolve(app, name), 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) env[match[1]] = '';
  }
}
Object.assign(env, {
  NEXT_PUBLIC_AUTH_PROVIDER: 'generic',
  NEXT_PUBLIC_CORE_TRANSPORT: 'server',
  NEXT_PUBLIC_TENANT_ID: '7',
  NEXT_PUBLIC_API_URL: 'https://hasura.invalid/v1/graphql',
  NEXT_PUBLIC_WS_URL: 'wss://hasura.invalid/v1/graphql',
  NEXT_PUBLIC_CITRINE_CORE_URL: 'https://core.invalid',
  NEXT_PUBLIC_APP_NAME: 'Isolated CitrineOS validation',
  NEXTAUTH_URL: 'http://127.0.0.1:39876',
  NEXTAUTH_SECRET: 'isolated-build-only-never-a-deployed-secret',
});
// Masking sample variables above must never erase the workload's own limits.
env.NODE_ENV = 'production';
env.NODE_OPTIONS = `--max-old-space-size=${heap}`;
const result = spawnSync(
  'pnpm',
  ['--workspace-concurrency=1', '--filter', '@citrineos/operator-ui', 'run', 'build'],
  { cwd: root, env, stdio: 'inherit', timeout: 1_200_000 },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const standalone = resolve(app, '.next/standalone');
const server = resolve(standalone, 'apps/operator-ui/server.js');
assert.ok(existsSync(server), 'Expected monorepo standalone entry is missing');
const isolated = mkdtempSync(join(tmpdir(), 'citrine-operator-artifact-'));
let probe;
try {
  cpSync(standalone, isolated, { recursive: true, dereference: false, verbatimSymlinks: true });
  probe = spawnSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const standalone = fs.realpathSync(process.argv[2]);
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      assert.ok(target.startsWith(standalone + path.sep), 'Artifact symlink escapes standalone tree');
    } else if (entry.isDirectory()) inspect(file);
  }
}
inspect(standalone);
const req = require('node:module').createRequire(process.argv[1]);
const file = path.join(standalone, 'apps/operator-ui/.next/server/app/api/core/[...path]/route.js');
const route = req(file);
assert.equal(typeof route.routeModule?.userland?.GET, 'function');
assert.equal(typeof route.routeModule?.userland?.POST, 'function');
assert.equal(typeof route.routeModule?.userland?.DELETE, 'function');`,
      resolve(isolated, 'apps/operator-ui/server.js'),
      isolated,
    ],
    { cwd: isolated, env, stdio: 'inherit', timeout: 30_000 },
  );
  assert.equal(probe.status, 0, 'Isolated standalone Core route loading failed');
} finally {
  rmSync(isolated, { recursive: true, force: true });
}
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
assert.equal(sha.status, 0);
assert.match(sha.stdout.trim(), /^[a-f0-9]{40}$/);
const pkg = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8'));
writeFileSync(
  resolve(root, 'operator-build-validation.json'),
  JSON.stringify(
    {
      component: pkg.name,
      version: pkg.version,
      sourceSha: sha.stdout.trim(),
      buildExitCode: 0,
      standaloneCoreRouteVerified: true,
      profile: 'synthetic-generic-server',
      deploymentPerformed: false,
      liveStationOrSmsTest: false,
      imageDigest: null,
    },
    null,
    2,
  ) + '\n',
);
