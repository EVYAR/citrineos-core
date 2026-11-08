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
function validateOwnedRelay(grant, info) {
  const proxy = grant.proxy;
  assert.ok(proxy && typeof proxy === 'object');
  assert.equal(proxy.host, grant.host);
  assert.equal(proxy.port, grant.port);
  assert.equal(proxy.targetPort, 5432);
  assert.equal(proxy.nonce, grant.nonce);
  assert.ok(Number.isSafeInteger(proxy.pid) && proxy.pid > 1);
  assert.match(proxy.startTime, /^[0-9]+$/);
  assert.equal(
    proxy.scriptSha256,
    'e0f19486e4c00e6a0c0d86ee521eaab8b258a769ede59e25413fffb2f1de473c',
    'Relay script differs from parent-reviewed source',
  );
  const networkName = grant.networkName ?? grant.network;
  assert.match(networkName, /^[a-zA-Z0-9_.-]+$/);
  assert.match(proxy.targetIp, /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
  assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [networkName]);
  const attached = info.NetworkSettings.Networks[networkName];
  const networkId = grant.networkId ?? attached.NetworkID;
  assert.match(networkId, /^[a-f0-9]{64}$/);
  assert.equal(attached.NetworkID, networkId);
  assert.equal(attached.IPAddress, proxy.targetIp);
  const network = JSON.parse(
    execFileSync('docker', ['network', 'inspect', networkId], { encoding: 'utf8' }),
  )[0];
  assert.equal(network.Id, networkId);
  assert.equal(network.Name, networkName);
  assert.equal(network.Internal, true);
  assert.equal(network.Labels['evyar.task'], task);
  assert.equal(network.Labels['evyar.nonce'], grant.nonce);
  assert.ok(
    Object.values(info.NetworkSettings.Ports).every(
      (binding) => binding === null || binding.length === 0,
    ),
    'Relay topology must not publish any host port',
  );
  const processRoot = `/proc/${proxy.pid}`;
  assert.equal(fs.statSync(processRoot).uid, process.getuid());
  const processIdentity = () => {
    // comm may contain spaces/parentheses; field22 is starttime, field3 begins after final ')'.
    const stat = fs.readFileSync(processRoot + '/stat', 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
  };
  assert.equal(processIdentity(), proxy.startTime, 'Relay PID was reused');
  const command = fs
    .readFileSync(processRoot + '/cmdline', 'utf8')
    .split('\0')
    .filter(Boolean);
  assert.match(path.basename(fs.readlinkSync(processRoot + '/exe')), /^python3(?:\.[0-9]+)?$/);
  assert.ok(path.isAbsolute(proxy.script));
  assert.ok(command.includes(proxy.script), 'Relay must run granted script');
  const script = fs.lstatSync(proxy.script);
  assert.ok(script.isFile() && !script.isSymbolicLink());
  assert.equal(script.uid, process.getuid());
  assert.equal(script.mode & 0o022, 0, 'Relay script cannot be writable by other users');
  assert.equal(sha(fs.readFileSync(proxy.script)), proxy.scriptSha256);
  // Reviewed parent script: python3 SCRIPT TARGET_IP READY_FILE NONCE; loopback random port,
  // target5432, semaphore12 and idle120s are pinned by the reviewed source digest.
  const scriptIndex = command.indexOf(proxy.script);
  assert.ok(scriptIndex >= 1);
  assert.equal(command.length, scriptIndex + 4);
  assert.equal(command[scriptIndex + 1], proxy.targetIp);
  assert.equal(command[scriptIndex + 3], grant.nonce);
  const readyPath = command[scriptIndex + 2];
  assert.ok(path.isAbsolute(readyPath));
  const readyStat = fs.lstatSync(readyPath);
  assert.ok(readyStat.isFile() && !readyStat.isSymbolicLink());
  assert.equal(readyStat.uid, process.getuid());
  assert.equal(readyStat.mode & 0o077, 0);
  const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  for (const field of ['pid', 'startTime', 'host', 'port', 'targetIp', 'targetPort', 'nonce']) {
    assert.equal(ready[field], proxy[field], 'Ready proxy evidence differs from grant');
  }
  assert.match(grant.workspaceContainerId, /^[a-f0-9]{64}$/);
  const runner = JSON.parse(
    execFileSync('docker', ['inspect', grant.workspaceContainerId], { encoding: 'utf8' }),
  )[0];
  assert.equal(runner.Id, grant.workspaceContainerId);
  assert.equal(runner.State.Running, true);
  assert.equal(runner.Config.Hostname, require('node:os').hostname());
  assert.equal(runner.NetworkSettings.Networks[networkName]?.NetworkID, networkId);
  const socketInodes = new Set(
    fs.readdirSync(processRoot + '/fd').flatMap((fd) => {
      try {
        const match = /^socket:\[([0-9]+)\]$/.exec(fs.readlinkSync(processRoot + '/fd/' + fd));
        return match ? [match[1]] : [];
      } catch (error) {
        if (error.code === 'ENOENT') return []; // an unrelated accepted socket may close during inspection
        throw error;
      }
    }),
  );
  const port = grant.port.toString(16).toUpperCase().padStart(4, '0');
  const listeners = fs
    .readFileSync(processRoot + '/net/tcp', 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[3] === '0A' && socketInodes.has(columns[9]));
  assert.deepEqual(
    listeners.map((columns) => columns[1]),
    [`0100007F:${port}`],
    'Relay must own exactly the granted IPv4 loopback listener',
  );
  const ipv6 = fs
    .readFileSync(processRoot + '/net/tcp6', 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[3] === '0A' && socketInodes.has(columns[9]));
  assert.equal(ipv6.length, 0, 'Relay must not own an IPv6/wildcard listener');
  assert.equal(processIdentity(), proxy.startTime, 'Relay identity changed during inspection');
}
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
  assert.ok(Number.isInteger(grant.port) && grant.port > 1024 && grant.port <= 65535);
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
  if (
    grant.transport === 'owned-loopback-relay' ||
    (grant.transport === undefined && grant.proxy)
  ) {
    assert.ok(
      bindings == null || bindings.length === 0,
      'Relay cannot replace a published binding',
    );
    validateOwnedRelay(grant, info);
  } else {
    assert.ok(grant.transport === undefined || grant.transport === 'published-loopback');
    assert.deepEqual(bindings, [{ HostIp: '127.0.0.1', HostPort: String(grant.port) }]);
  }
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
  const guard = (stage) => {
    const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    report.resourceGuards ??= [];
    report.resourceGuards.push({
      stage,
      limitBytes: limit,
      currentBytes: current,
      availableMiB: Math.floor((limit - current) / 1048576),
      plannedAdditionalMiB: 1536,
      reserveMiB: 1536,
    });
    assert.ok(
      Number.isFinite(limit) && limit - current >= 3072 * 1048576,
      'Insufficient actual cgroup headroom; defer lane',
    );
  };
  const create = async (suffix) => {
    guard('create-' + suffix);
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
  const quiescent = async (name, terminalCliStartedAt) => {
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
      const deadline = Date.now() + 2000;
      let closing;
      for (;;) {
        const others = (
          await c.query(
            'SELECT pid,usename,application_name,state,backend_start FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid',
          )
        ).rows;
        if (others.length === 0) break;
        // A successful CLI process can exit before PostgreSQL observes its socket FIN.
        // Only its already-idle, exact-owner connections may finish disconnecting.
        // Pre-migration checks remain immediate; active or unfamiliar clients fail.
        assert.ok(
          terminalCliStartedAt &&
            others.every(
              (row) =>
                row.usename === grant.user &&
                row.application_name === marker &&
                row.state === 'idle' &&
                row.backend_start.getTime() >= terminalCliStartedAt,
            ),
          'All fixture clients must stop before migration: ' + JSON.stringify(others),
        );
        const identities = others.map((row) => `${row.pid}:${row.backend_start.toISOString()}`);
        if (!closing) {
          closing = new Set(identities);
          report.terminalCliDisconnects ??= [];
          report.terminalCliDisconnects.push({ database: name, clients: others });
        }
        assert.ok(
          identities.every((identity) => closing.has(identity)),
          'New client appeared after CLI exit',
        );
        assert.ok(Date.now() < deadline, 'Terminal CLI connections did not disconnect');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await c.end();
    }
  };
  const migrate = async (name, migrationsPath, tag) => {
    guard('migrate-' + tag);
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
    const terminalCliStartedAt = Date.now();
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
    await quiescent(name, terminalCliStartedAt);
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
    // Node's CJS named-export detection does not expose Sequelize.DataTypes. Preserve
    // the dependency objects through an ESM import facade; migration bodies stay intact.
    const sqlFacade = path.join(artifacts, 'historic-sequelize-imports.mjs');
    const sqlFacadeSource = `import sequelize from '${pathToFileURL(localRequire.resolve('sequelize')).href}'; export const { DataTypes, QueryTypes } = sequelize; export default sequelize;`;
    fs.writeFileSync(sqlFacade, sqlFacadeSource);
    report.historicalDependencyFacades = {
      baseSha256: sha(fs.readFileSync(facade)),
      sequelizeSha256: sha(sqlFacadeSource),
      purpose: 'ESM/CJS import interoperability only; no SQL/body replacement',
    };
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
        .replaceAll("from 'sequelize'", `from '${pathToFileURL(sqlFacade).href}'`)
        .replaceAll('from "sequelize"', `from '${pathToFileURL(sqlFacade).href}'`);
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
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, archiveRoot, 'provenance.json'), 'utf8'),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.baselineCommit, baseline);
    assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0);
    const archivedPaths = new Set();
    const originalPaths = new Set();
    const retiredArchives = manifest.entries.map((entry) => {
      assert.ok(entry && typeof entry === 'object');
      assert.equal(typeof entry.archivedPath, 'string');
      assert.equal(typeof entry.originalPath, 'string');
      const filename = path.posix.basename(entry.originalPath);
      assert.match(filename, /^[0-9]{14}-[a-z0-9-]+\.ts$/);
      assert.equal(entry.originalPath, 'apps/ocpp-server/migrations/' + filename);
      assert.equal(entry.archivedPath, archiveRoot + '/' + filename + '.txt');
      assert.ok(!archivedPaths.has(entry.archivedPath), 'Duplicate archive provenance');
      assert.ok(!originalPaths.has(entry.originalPath), 'Duplicate original migration');
      archivedPaths.add(entry.archivedPath);
      originalPaths.add(entry.originalPath);
      assert.match(entry.originalCommit, /^[a-f0-9]{40}$/);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0);
      git('merge-base', '--is-ancestor', entry.originalCommit, manifest.baselineCommit);
      const archiveFile = path.join(root, entry.archivedPath);
      const stat = fs.lstatSync(archiveFile);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Archive must be a regular file');
      const archived = fs.readFileSync(archiveFile);
      const original = git('show', entry.originalCommit + ':' + entry.originalPath);
      assert.equal(sha(original), entry.sha256, 'Original source SHA differs from manifest');
      assert.equal(sha(archived), entry.sha256, 'Archive SHA differs from manifest');
      assert.deepEqual(archived, original, 'Historic source archive must remain byte-identical');
      const stem = filename.slice(0, -3);
      // These spellings classify actual rows only; no alias is inserted into SequelizeMeta.
      const knownSpellings = [stem + '.js', stem + '.ts', stem + '.ts.txt'];
      return {
        archivedPath: entry.archivedPath,
        archiveSha256: sha(archived),
        originalCommit: entry.originalCommit,
        originalPath: entry.originalPath,
        originalSha256: sha(original),
        recordedNamesBefore: before.filter((value) => knownSpellings.includes(value)),
        recordedNamesAfter: after.filter((value) => knownSpellings.includes(value)),
      };
    });
    assert.deepEqual(
      fs
        .readdirSync(path.join(root, archiveRoot))
        .filter((entry) => entry.endsWith('.ts.txt'))
        .sort(),
      [...archivedPaths].map((entry) => path.posix.basename(entry)).sort(),
      'Manifest must describe the exact archive file set',
    );
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
    guard,
    migrate,
    prepareLegacy,
    migrationProof,
    dump,
    restore,
    cleanup,
  };
}
module.exports = { loadGrant, makeFixture, baseline, sha };
