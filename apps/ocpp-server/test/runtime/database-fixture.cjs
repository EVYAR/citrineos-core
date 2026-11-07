// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const localRequire = createRequire(path.join(root, 'packages/dal/package.json'));
const { Client } = localRequire('pg');
const baseline = 'af5f736f16e2c7390255b2e49d66769e41a7863f';
const task = 'core-runtime-20261107';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root });
function loadGrant() {
  assert.match(process.version, /^v24\./, 'Use parent Node24 wrapper');
  const file = process.env.CORE_RUNTIME_LOCAL_GRANT;
  assert.ok(file, 'Parent must supply an explicit local fixture grant');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Grant must be a regular private file');
  assert.equal(stat.uid, process.getuid(), 'Grant must belong to this task user');
  assert.equal(stat.mode & 0o077, 0, 'Grant file must be private');
  const grant = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(grant.task, task);
  assert.match(grant.nonce, /^[a-f0-9]{16}$/);
  assert.match(grant.containerId, /^[a-f0-9]{12,64}$/);
  assert.equal(grant.host, '127.0.0.1');
  assert.ok(Number.isInteger(grant.port) && grant.port > 1024);
  if (process.env.DOCKER_HOST)
    assert.match(process.env.DOCKER_HOST, /^unix:\/\//, 'Remote Docker daemons are forbidden');
  const context = JSON.parse(
    execFileSync('docker', ['context', 'inspect'], { encoding: 'utf8' }),
  )[0];
  assert.match(context.Endpoints.docker.Host, /^unix:\/\//, 'Use a local Docker socket only');
  const info = JSON.parse(
    execFileSync('docker', ['inspect', grant.containerId], { encoding: 'utf8' }),
  )[0];
  assert.equal(info.Config.Labels['evyar.task'], task);
  assert.equal(info.Config.Labels['evyar.nonce'], grant.nonce);
  assert.ok(
    info.HostConfig.Memory > 0 && info.HostConfig.Memory <= 1024 ** 3,
    'Fixture must have <=1GiB memory limit',
  );
  const bindings = info.NetworkSettings.Ports['5432/tcp'];
  assert.deepEqual(bindings, [{ HostIp: '127.0.0.1', HostPort: String(grant.port) }]);
  assert.equal(info.State.Running, true);
  assert.match(grant.user, /^evyar_core_runtime_/);
  assert.ok(typeof grant.password === 'string' && grant.password.length >= 16);
  return grant;
}
function makeFixture(grant) {
  const runId = crypto.randomBytes(3).toString('hex');
  const prefix = `evyar_core_runtime_${grant.nonce}_${runId}_`;
  const marker = `${task}:${grant.nonce}:${runId}`;
  const cache = path.join(root, 'node_modules/.cache');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const artifacts = fs.mkdtempSync(path.join(cache, prefix));
  fs.chmodSync(artifacts, 0o700);
  const owned = new Set();
  const report = {
    task,
    nonce: grant.nonce,
    runId,
    containerId: grant.containerId,
    ownerMarker: marker,
    ownedDatabases: [],
    sourceCommit: git('rev-parse', 'HEAD').toString().trim(),
    baseline,
    assertions: [],
    migrationSources: [],
    artifacts,
  };
  const connect = async (database) => {
    assert.ok(database === 'postgres' || database.startsWith(prefix));
    const c = new Client({
      host: grant.host,
      port: grant.port,
      user: grant.user,
      password: grant.password,
      database,
      application_name: marker,
      connectionTimeoutMillis: 5000,
      statement_timeout: 60000,
    });
    await c.connect();
    return c;
  };
  const create = async (suffix) => {
    assert.match(suffix, /^[a-z0-9_]+$/);
    const name = prefix + suffix;
    const c = await connect('postgres');
    try {
      assert.equal(
        (await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount,
        0,
        'Never overwrite a database',
      );
      await c.query(`CREATE DATABASE "${name}"`);
      await c.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
      owned.add(name);
      report.ownedDatabases = [...owned];
    } finally {
      await c.end();
    }
    const db = await connect(name);
    try {
      await db.query('CREATE EXTENSION postgis');
    } finally {
      await db.end();
    }
    return name;
  };
  const quiescent = async (name) => {
    assert.ok(owned.has(name));
    const c = await connect(name);
    try {
      const identity = (
        await c.query(
          "SELECT current_database() name,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0];
      assert.equal(identity.name, name);
      assert.equal(identity.marker, marker);
      const others = (
        await c.query(
          'SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        )
      ).rows[0].n;
      assert.equal(others, 0, 'All fixture clients must stop before migration');
    } finally {
      await c.end();
    }
  };
  const migrate = async (name, migrationsPath, tag) => {
    await quiescent(name);
    const config = path.join(artifacts, `${tag}-config.json`);
    fs.writeFileSync(
      config,
      JSON.stringify({
        test: {
          dialect: 'postgres',
          host: grant.host,
          port: grant.port,
          username: grant.user,
          password: grant.password,
          database: name,
          logging: false,
          dialectOptions: { application_name: marker, statement_timeout: 60000 },
        },
      }),
      { mode: 0o600 },
    );
    const command = spawnSync(
      process.execPath,
      [
        require.resolve('sequelize-cli/lib/sequelize'),
        'db:migrate',
        '--env',
        'test',
        '--config',
        config,
        '--migrations-path',
        migrationsPath,
      ],
      {
        cwd: root,
        env: { ...process.env, EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER: 'acknowledged' },
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(artifacts, `${tag}-migrate.log`),
      String(command.stdout || '') + String(command.stderr || ''),
      { mode: 0o600 },
    );
    fs.unlinkSync(config);
    assert.equal(command.status, 0, `${tag} migration failed; inspect private fixture log`);
    await quiescent(name);
    const c = await connect(name);
    try {
      return (await c.query('SELECT name FROM "SequelizeMeta" ORDER BY name')).rows.map(
        (r) => r.name,
      );
    } finally {
      await c.end();
    }
  };
  const prepareLegacy = async () => {
    const ts = require(path.join(root, 'node_modules/typescript/lib/typescript.js'));
    const directory = path.join(artifacts, 'baseline-migrations');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    const enums = await import(pathToFileURL(path.join(root, 'packages/types/dist/index.js')).href);
    assert.deepEqual(Object.values(enums.AuthorizationWhitelistEnum).sort(), [
      'Allowed',
      'AllowedOffline',
      'Never',
    ]);
    const enumSource = git(
      'show',
      baseline + ':packages/base/src/interfaces/dto/types/enums.ts',
    ).toString();
    assert.match(
      enumSource,
      /AuthorizationWhitelistEnumSchema = z.enum\(\['Never', 'Allowed', 'AllowedOffline'\]\)/,
    );
    const base = await import(pathToFileURL(path.join(root, 'packages/base/dist/index.js')).href);
    assert.equal(base.DEFAULT_TENANT_ID, 1);
    const facade = path.join(artifacts, 'historic-base-imports.mjs');
    fs.writeFileSync(
      facade,
      `export const DEFAULT_TENANT_ID = 1; export const AuthorizationWhitelistEnum = ${JSON.stringify(enums.AuthorizationWhitelistEnum)};`,
    );
    const files = git('ls-tree', '-r', '--name-only', baseline, '--', 'apps/ocpp-server/migrations')
      .toString()
      .trim()
      .split('\n');
    assert.equal(files.length, 52);
    for (const sourcePath of files) {
      const original = git('show', baseline + ':' + sourcePath);
      const source = original.toString();
      const emitted = ts
        .transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
          fileName: sourcePath,
        })
        .outputText.replaceAll("from '@citrineos/base'", `from '${pathToFileURL(facade).href}'`)
        .replaceAll('from "@citrineos/base"', `from '${pathToFileURL(facade).href}'`)
        .replaceAll(
          "from 'sequelize'",
          `from '${pathToFileURL(localRequire.resolve('sequelize')).href}'`,
        )
        .replaceAll(
          'from "sequelize"',
          `from '${pathToFileURL(localRequire.resolve('sequelize')).href}'`,
        );
      const filename = path.basename(sourcePath, '.ts') + '.js';
      fs.writeFileSync(path.join(directory, filename), emitted);
      report.migrationSources.push({
        sourcePath,
        filename,
        sourceSha256: sha(original),
        emittedSha256: sha(emitted),
      });
    }
    return directory;
  };
  const migrationProof = async (name, lane, before, after) => {
    assert.ok(owned.has(name));
    for (const recordedName of before)
      assert.ok(after.includes(recordedName), 'Applied history must not be removed or normalized');
    const active = report.currentMigrationSources;
    for (const migration of active) {
      const discoveredName = migration.filename.replace(/\.ts$/, '.js');
      assert.ok(
        after.includes(discoveredName),
        `Actual CLI did not record active migration ${discoveredName}`,
      );
    }
    const archiveRoot = 'docs/upstream/historical-migrations';
    const retiredArchives = fs
      .readdirSync(path.join(root, archiveRoot))
      .filter((entry) => entry.endsWith('.ts.txt'))
      .sort()
      .map((entry) => {
        const originalPath = 'apps/ocpp-server/migrations/' + entry.slice(0, -4);
        const archivedPath = archiveRoot + '/' + entry;
        const archived = fs.readFileSync(path.join(root, archivedPath));
        const original = git('show', baseline + ':' + originalPath);
        assert.deepEqual(archived, original, 'Historic source archive must remain byte-identical');
        const stem = entry.slice(0, -7);
        // These spellings classify actual rows only; no alias is inserted into SequelizeMeta.
        const knownSpellings = [stem + '.js', stem + '.ts', stem + '.ts.txt'];
        return {
          archivedPath,
          archiveSha256: sha(archived),
          originalCommit: baseline,
          originalPath,
          originalSha256: sha(original),
          recordedNamesBefore: before.filter((value) => knownSpellings.includes(value)),
          recordedNamesAfter: after.filter((value) => knownSpellings.includes(value)),
        };
      });
    const c = await connect(name);
    let database;
    try {
      database = (
        await c.query(
          "SELECT current_database() name,shobj_description(oid,'pg_database') ownerMarker FROM pg_database WHERE datname=current_database() ",
        )
      ).rows[0];
      assert.equal(database.name, name);
      assert.equal(database.ownermarker, marker);
      const actual = (await c.query('SELECT name FROM "SequelizeMeta" ORDER BY name')).rows.map(
        (row) => row.name,
      );
      assert.deepEqual(
        actual,
        after,
        'Proof must reflect queried ledger, not discovered filenames',
      );
    } finally {
      await c.end();
    }
    const proof = {
      schemaVersion: 1,
      kind: 'evyar-core-migration-proof',
      lane,
      recordedAt: new Date().toISOString(),
      sourceCommit: report.sourceCommit,
      sourceDirtyPaths: git('status', '--porcelain').toString().split('\n').filter(Boolean),
      database: { name, ownerMarker: marker, containerId: grant.containerId },
      activeMigrations: active,
      history: { before: [...before], after: [...after], preservedBeforeExactly: true },
      retiredArchives,
      outcome: 'migration-only-pass',
      limitations: [
        'Synthetic migration-source fixture; not production acceptance',
        'Overall runtime/retention acceptance is separate',
      ],
    };
    const artifact = path.join(artifacts, lane + '-migration-proof.json');
    fs.writeFileSync(artifact, JSON.stringify(proof, null, 2), { mode: 0o600 });
    report.migrationProofs ??= [];
    report.migrationProofs.push({ lane, artifact, sha256: sha(fs.readFileSync(artifact)) });
    return proof;
  };
  const dump = async (name) => {
    await quiescent(name);
    const file = path.join(artifacts, `${name}.dump`);
    const result = spawnSync(
      'docker',
      [
        'exec',
        '-e',
        'PGPASSWORD=' + grant.password,
        grant.containerId,
        'pg_dump',
        '--username',
        grant.user,
        '--dbname',
        name,
        '--format=custom',
        '--no-owner',
        '--no-privileges',
      ],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, 'fixture dump failed');
    fs.writeFileSync(file, result.stdout, { mode: 0o600 });
    report.assertions.push({ dump: path.basename(file), sha256: sha(result.stdout) });
    return file;
  };
  const restore = async (name, file) => {
    await quiescent(name);
    assert.equal(path.dirname(file), artifacts);
    const result = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD=' + grant.password,
        grant.containerId,
        'pg_restore',
        '--username',
        grant.user,
        '--dbname',
        name,
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
      ],
      { input: fs.readFileSync(file), timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, 'fixture restore failed');
  };
  const cleanup = async () => {
    for (const name of owned) {
      await quiescent(name);
      const c = await connect('postgres');
      try {
        await c.query(`DROP DATABASE "${name}"`);
      } finally {
        await c.end();
      }
    }
    report.cleanedDatabases = [...owned];
  };
  return {
    grant,
    root,
    artifacts,
    report,
    connect,
    create,
    quiescent,
    migrate,
    prepareLegacy,
    migrationProof,
    dump,
    restore,
    cleanup,
  };
}
module.exports = { loadGrant, makeFixture, baseline, sha };
