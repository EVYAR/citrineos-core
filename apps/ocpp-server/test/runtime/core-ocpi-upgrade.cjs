// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { loadGrant, makeFixture, sha } = require('./database-fixture.cjs');
const oldOcpiCommit = '8326909087ed7c56f2d0d77cf5e29f09defa35f3';
const oldOcpiRoot = process.env.CORE_RUNTIME_OLD_OCPI_SOURCE;
assert.ok(oldOcpiRoot && path.isAbsolute(oldOcpiRoot), 'Explicit frozen OCPI source checkout required');
const repairName = '20261107210000-restore-partition-notification-bindings.js';
const gitOld = (...args) => execFileSync('git', ['-C', oldOcpiRoot, ...args]);
const ledger = async (db) =>
  (await db.query('SELECT name FROM public."SequelizeMeta" ORDER BY name')).rows.map((r) => r.name);
async function inventory(db) {
  return (
    await db.query(`SELECT t.oid::text, c.relname AS relation, t.tgname, t.tgparentid::text,
      t.tgenabled, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgparentid=0
      ORDER BY c.relname,t.tgname`)
  ).rows;
}
async function snapshot(f, name) {
  const db = await f.connect(name);
  try {
    return { ledger: await ledger(db), triggers: await inventory(db) };
  } finally {
    await db.end();
  }
}
function active(f, surface) {
  const source = path.join(f.root, `apps/${surface}-server/db/migrations`);
  const compiled = path.join(f.root, `apps/${surface}-server/dist/migrations`);
  const names = fs
    .readdirSync(source)
    .filter((n) => n.endsWith('.ts'))
    .sort();
  assert.deepEqual(
    fs
      .readdirSync(compiled)
      .filter((n) => n.endsWith('.js'))
      .sort(),
    names.map((n) => n.replace(/\.ts$/, '.js')),
    'Build current sources and remove stale compiled migrations before granting execution',
  );
  return {
    directory: compiled,
    migrations: names.map((name) => ({
      sourcePath: path.relative(f.root, path.join(source, name)),
      filename: name.replace(/\.ts$/, '.js'),
      sourceSha256: sha(fs.readFileSync(path.join(source, name))),
      emittedSha256: sha(fs.readFileSync(path.join(compiled, name.replace(/\.ts$/, '.js')))),
    })),
  };
}
function historicOcpi(f) {
  const ts = require(path.join(f.root, 'node_modules/typescript/lib/typescript.js'));
  const directory = path.join(f.artifacts, 'historic-ocpi');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  const files = gitOld('ls-tree', '-r', '--name-only', oldOcpiCommit, '--', 'migrations')
    .toString()
    .trim()
    .split('\n')
    .filter((n) => n.endsWith('.ts'));
  assert.equal(files.length, 7);
  const migrations = files.map((sourcePath) => {
    const original = gitOld('show', `${oldOcpiCommit}:${sourcePath}`);
    const current = fs.readFileSync(
      path.join(f.root, 'apps/ocpi-server/db/migrations', path.basename(sourcePath)),
    );
    assert.deepEqual(current, original, 'Applied historic OCPI migration body changed');
    const emitted = ts.transpileModule(original.toString(), {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      fileName: sourcePath,
    }).outputText;
    const filename = path.basename(sourcePath, '.ts') + '.js';
    fs.writeFileSync(path.join(directory, filename), emitted);
    return { sourcePath, filename, sourceSha256: sha(original), emittedSha256: sha(emitted) };
  });
  return { directory, migrations };
}
async function sqlRepairCases(f, name, compiled) {
  await f.quiescent(name);
  const localRequire = createRequire(path.join(f.root, 'packages/dal/package.json'));
  const { Sequelize } = localRequire('sequelize');
  const sequelize = new Sequelize(name, f.grant.user, f.grant.password, {
    dialect: 'postgres',
    host: f.grant.host,
    port: f.grant.port,
    logging: false,
    pool: { max: 1, min: 0 },
    dialectOptions: { application_name: f.report.ownerMarker, statement_timeout: 60000 },
  });
  const repair = (await import(pathToFileURL(path.join(compiled, repairName)).href)).default;
  const query = (sql) => sequelize.query(sql);
  const bindings = async () =>
    (
      await query(`SELECT oid::text,tgname FROM pg_trigger
    WHERE tgrelid IN ('public."Transactions"'::regclass,'public."MeterValues"'::regclass)
    AND tgname IN ('TransactionNotification','MeterValueNotification') ORDER BY tgname`)
    )[0];
  try {
    const before = await bindings();
    assert.equal(before.length, 2);
    await repair.up(sequelize.getQueryInterface());
    assert.deepEqual(await bindings(), before, 'working trigger OIDs must survive repeated up');
    await repair.down(sequelize.getQueryInterface());
    assert.deepEqual(await bindings(), before, 'down preserves preexisting and repaired bindings');
    await query('DROP TRIGGER "TransactionNotification" ON public."Transactions"');
    await query(
      'ALTER FUNCTION public."MeterValueNotify"() RENAME TO "FixtureMissingMeterValueNotify"',
    );
    try {
      await assert.rejects(
        repair.up(sequelize.getQueryInterface()),
        /OCPI_NOTIFICATION_FUNCTION_MISSING/,
      );
      assert.equal((await bindings()).length, 1, 'earlier trigger creation rolls back atomically');
    } finally {
      await query(
        'ALTER FUNCTION public."FixtureMissingMeterValueNotify"() RENAME TO "MeterValueNotify"',
      );
      await repair.up(sequelize.getQueryInterface());
    }
    await query('ALTER TABLE public."MeterValues" DISABLE TRIGGER "MeterValueNotification"');
    try {
      await assert.rejects(
        repair.up(sequelize.getQueryInterface()),
        /OCPI_NOTIFICATION_BINDING_CONFLICT/,
      );
    } finally {
      await query('ALTER TABLE public."MeterValues" ENABLE TRIGGER "MeterValueNotification"');
    }
    await query(
      'ALTER TRIGGER "MeterValueNotification" ON public."MeterValues" RENAME TO "FixtureOtherBinding"',
    );
    try {
      await assert.rejects(
        repair.up(sequelize.getQueryInterface()),
        /OCPI_NOTIFICATION_BINDING_CONFLICT/,
      );
    } finally {
      await query(
        'ALTER TRIGGER "FixtureOtherBinding" ON public."MeterValues" RENAME TO "MeterValueNotification"',
      );
    }
    const repaired = await bindings();
    await repair.down(sequelize.getQueryInterface());
    await repair.up(sequelize.getQueryInterface());
    assert.deepEqual(await bindings(), repaired);
    return {
      workingOids: before,
      repairedOids: repaired,
      cases: [
        'existing standard bindings unchanged',
        'repeat up',
        'no-op down preserves bindings',
        'missing second function rolls back first trigger creation',
        'disabled binding fails closed',
        'alternate binding name fails closed without duplicate creation',
      ],
    };
  } finally {
    await sequelize.close();
  }
}
async function notifications(f, name) {
  const db = await f.connect(name);
  const listener = await f.connect(name);
  const received = [];
  listener.on('notification', (n) =>
    received.push({ channel: n.channel, ...JSON.parse(n.payload) }),
  );
  try {
    await listener.query('LISTEN "TransactionNotification"');
    await listener.query('LISTEN "MeterValueNotification"');
    await db.query(`INSERT INTO "Tenants" (id,name,"createdAt","updatedAt")
      VALUES (91002,'SYNTHETIC-OCPI-OTHER',now(),now())`);
    await db.query(`INSERT INTO "ChargingStations" (id,"tenantId","ocppConnectionName",protocol,"createdAt","updatedAt") VALUES
      (91001,1,'SYNTHETIC-OCPI-A','ocpp1.6',now(),now()),
      (91002,91002,'SYNTHETIC-OCPI-B','ocpp1.6',now(),now())`);
    const dates = (
      await db.query(`SELECT
      to_char(date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 day 0.123456 seconds',
        'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS a,
      to_char(date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 month 1 day 0.654321 seconds',
        'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS b,
      to_char(date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 month 2 days 0.987654 seconds',
        'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS c`)
    ).rows[0];
    const witnesses = [
      { tenantId: 1, stationId: 91001, createdAt: dates.a },
      { tenantId: 1, stationId: 91001, createdAt: dates.b },
      { tenantId: 91002, stationId: 91002, createdAt: dates.c },
    ];
    const partitionRelations = [];
    for (const [index, w] of witnesses.entries()) {
      const inserted = await db.query(
        `INSERT INTO "Transactions"
        (id,"tenantId","stationId","transactionId","createdAt","updatedAt","isActive")
        VALUES (919001,$1,$2,$3,$4,now(),false) RETURNING tableoid::regclass::text AS partition`,
        [w.tenantId, w.stationId, `synthetic-ocpi-${index}`, w.createdAt],
      );
      partitionRelations.push(inserted.rows[0].partition);
      await db.query(
        `UPDATE "Transactions" SET "isActive"=true,"updatedAt"=now()
        WHERE id=919001 AND "tenantId"=$1 AND "createdAt"=$2`,
        [w.tenantId, w.createdAt],
      );
      await db.query(
        `INSERT INTO "MeterValues"
        (id,"tenantId","transactionDatabaseId","transactionCreatedAt","timestamp","createdAt","updatedAt","sampledValue")
        VALUES ($1,$2,919001,$3,now(),now(),now(),'[]')`,
        [919100 + index, w.tenantId, w.createdAt],
      );
    }
    assert.notEqual(
      partitionRelations[0],
      partitionRelations[1],
      'witnesses use distinct actual partitions',
    );
    assert.equal(
      partitionRelations[1],
      partitionRelations[2],
      'other tenant also shares a current physical partition',
    );
    // A server round trip cannot guarantee delivery on the separate LISTEN socket.
    const deadline = Date.now() + 5000;
    while (received.length < 9 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      received.length,
      9,
      'exactly one notification per row operation, including partition clones',
    );
    for (const [index, w] of witnesses.entries()) {
      const transactions = received.filter(
        (n) =>
          n.channel === 'TransactionNotification' &&
          n.data.tenantId === w.tenantId &&
          n.data.createdAt === w.createdAt,
      );
      assert.deepEqual(transactions.map((n) => n.operation).sort(), ['INSERT', 'UPDATE']);
      for (const n of transactions) {
        assert.equal(n.data.id, 919001);
        assert.equal(n.data.stationId, w.stationId);
        assert.equal(n.data.tenant.id, w.tenantId);
      }
      const meters = received.filter(
        (n) => n.channel === 'MeterValueNotification' && n.data.id === 919100 + index,
      );
      assert.equal(meters.length, 1);
      assert.equal(meters[0].data.transactionDatabaseId, 919001);
      assert.equal(meters[0].data.transactionCreatedAt, w.createdAt);
      assert.equal(meters[0].data.tenantId, w.tenantId);
      assert.equal(meters[0].data.tenant.id, w.tenantId);
    }
    return {
      witnesses,
      partitionRelations,
      notifications: received,
      cases: [
        'current parent INSERT/UPDATE LISTEN',
        'microseconds preserved in JSON',
        'same numeric transaction id across partitions and tenants',
        'meter exact composite identity',
        'no duplicate inherited notifications or cross-owner payloads',
      ],
    };
  } finally {
    await listener.end();
    await db.end();
  }
}
(async () => {
  const f = makeFixture(loadGrant());
  let success = false;
  try {
    const core = active(f, 'ocpp');
    const ocpi = active(f, 'ocpi');
    const oldOcpi = historicOcpi(f);
    const proof = (f.report.pairedOcpiProof = {
      schemaVersion: 1,
      oldOcpiCommit,
      historicalOcpiMigrations: oldOcpi.migrations,
      activeCoreMigrations: core.migrations,
      activeOcpiMigrations: ocpi.migrations,
      lanes: {},
    });
    for (const lane of ['fresh', 'upgraded']) {
      const name = await f.create(`ocpi_${lane}`);
      const record = (proof.lanes[lane] = { database: name });
      if (lane === 'upgraded') {
        const oldCore = await f.prepareLegacy();
        const coreLedger = await f.migrate(name, oldCore, 'paired-old-core');
        assert.equal(coreLedger.length, 52);
        const combined = await f.migrate(name, oldOcpi.directory, 'paired-old-ocpi');
        assert.deepEqual(
          combined,
          [...coreLedger, ...oldOcpi.migrations.map((m) => m.filename)].sort(),
        );
      }
      record.beforeCore = await snapshot(f, name).catch((error) => {
        if (lane === 'fresh' && error.code === '42P01') return { ledger: [], triggers: [] };
        throw error;
      });
      await f.migrate(name, core.directory, `paired-${lane}-core`);
      record.afterCore = await snapshot(f, name);
      for (const row of record.beforeCore.ledger) assert.ok(record.afterCore.ledger.includes(row));
      for (const m of core.migrations) assert.ok(record.afterCore.ledger.includes(m.filename));
      if (lane === 'upgraded') {
        for (const [relation, tgname] of [
          ['Transactions', 'TransactionNotification'],
          ['MeterValues', 'MeterValueNotification'],
        ]) {
          assert.ok(
            record.beforeCore.triggers.some((t) => t.relation === relation && t.tgname === tgname),
          );
          assert.ok(
            record.afterCore.triggers.some(
              (t) => t.relation === relation + '_old' && t.tgname === tgname,
            ),
          );
          assert.ok(
            !record.afterCore.triggers.some((t) => t.relation === relation && t.tgname === tgname),
          );
        }
      }
      if (lane === 'fresh') {
        const prefix = path.join(f.artifacts, 'ocpi-before-repair');
        fs.mkdirSync(prefix, { mode: 0o700 });
        fs.writeFileSync(path.join(prefix, 'package.json'), '{"type":"module"}');
        for (const m of ocpi.migrations) {
          if (m.filename !== repairName)
            fs.copyFileSync(path.join(ocpi.directory, m.filename), path.join(prefix, m.filename));
        }
        await f.migrate(name, prefix, 'paired-fresh-ocpi-before-repair');
        record.beforeRepair = await snapshot(f, name);
      }
      await f.migrate(name, ocpi.directory, `paired-${lane}-ocpi`);
      record.afterOcpi = await snapshot(f, name);
      for (const row of record.afterCore.ledger) assert.ok(record.afterOcpi.ledger.includes(row));
      for (const m of ocpi.migrations) assert.ok(record.afterOcpi.ledger.includes(m.filename));
      if (lane === 'fresh') {
        const standard = (rows) =>
          rows.filter(
            (t) =>
              ['Transactions', 'MeterValues'].includes(t.relation) &&
              ['TransactionNotification', 'MeterValueNotification'].includes(t.tgname),
          );
        assert.equal(standard(record.beforeRepair.triggers).length, 2);
        assert.deepEqual(
          standard(record.afterOcpi.triggers),
          standard(record.beforeRepair.triggers),
          'first repair up must preserve fresh standard trigger OIDs and definitions',
        );
      }
      record.sqlRepair = await sqlRepairCases(f, name, ocpi.directory);
      record.notificationProof = await notifications(f, name);
      await f.migrate(name, ocpi.directory, `paired-${lane}-repeat`);
      record.afterRepeat = await snapshot(f, name);
      assert.deepEqual(record.afterRepeat.ledger, record.afterOcpi.ledger);
    }
    await f.cleanup();
    success = true;
  } catch (error) {
    f.report.failure = { message: String(error.message), stack: String(error.stack) };
    throw error;
  } finally {
    f.report.success = success;
    fs.writeFileSync(path.join(f.artifacts, 'result.json'), JSON.stringify(f.report, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify({ success, report: path.join(f.artifacts, 'result.json') }));
  }
})().catch((error) => {
  console.error(String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[PRIVATE_CONNECTION]'));
  process.exitCode = 1;
});
