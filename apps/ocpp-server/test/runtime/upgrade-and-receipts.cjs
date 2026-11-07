// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { loadGrant, makeFixture } = require('./database-fixture.cjs');
const connection = '00000000-0000-4000-8000-000000000001';
async function baselineRows(db) {
  await db.query(
    `INSERT INTO "ChargingStations" (id,"tenantId","ocppConnectionName",protocol,"isOnline","use16StatusNotification0","statusIngressConnection","createdAt","updatedAt") VALUES (90001,1,'SYNTHETIC-UPGRADE','ocpp1.6',false,true,$1,now(),now())`,
    [connection],
  );
  await db.query(
    `INSERT INTO "EvseTypes" ("databaseId",id,"connectorId","tenantId","createdAt","updatedAt") VALUES (90001,1,NULL,1,now(),now())`,
  );
  await db.query(
    `INSERT INTO "Evses" (id,"stationId","ocppConnectionName","evseTypeId","tenantId","createdAt","updatedAt") VALUES (90001,90001,'SYNTHETIC-UPGRADE',1,1,now(),now())`,
  );
  await db.query(
    `INSERT INTO "Connectors" (id,"stationId","ocppConnectionName","connectorId","evseId","evseTypeConnectorId",status,"tenantId","createdAt","updatedAt") VALUES (90001,90001,'SYNTHETIC-UPGRADE',1,90001,90001,'Available',1,now(),now())`,
  );
  const frame = [
    2,
    'old-bound-call',
    'StatusNotification',
    {
      connectorId: 1,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: '2020-01-01T00:00:00Z',
    },
  ];
  await db.query(
    `INSERT INTO "OCPPMessages" (id,"tenantId","stationId","ocppConnectionName","statusIngressConnection","correlationId",origin,state,protocol,action,message,timestamp,"createdAt","updatedAt") VALUES (94001,1,90001,'SYNTHETIC-UPGRADE',$1,'old-bound-call','cs','1','ocpp1.6','StatusNotification',$2::jsonb,'2020-01-01','2020-01-01','2020-01-01')`,
    [connection, JSON.stringify(frame)],
  );
  await db.query(
    `INSERT INTO "StatusNotifications" (id,"tenantId","stationId","ocppConnectionName","connectorId","evseId","connectorStatus",timestamp,"ingressMessageId","createdAt","updatedAt") VALUES (95001,1,90001,'SYNTHETIC-UPGRADE',1,1,'Available','2020-01-01',94001,now(),now())`,
  );
  await db.query(
    `INSERT INTO "LatestStatusNotifications" ("tenantId","stationId","ocppConnectionName","statusNotificationId","createdAt","updatedAt") VALUES (1,90001,'SYNTHETIC-UPGRADE',95001,now(),now())`,
  );
  return frame;
}
// Exercise real forward bridge without inventing a SequelizeMeta entry. CLI records it later.
async function exerciseBridgePreflight(f, name, current, frame) {
  await f.quiescent(name);
  const localRequire = createRequire(path.join(f.root, 'packages/dal/package.json'));
  const { Sequelize } = localRequire('sequelize');
  const db = new Sequelize(name, f.grant.user, f.grant.password, {
    dialect: 'postgres',
    host: f.grant.host,
    port: f.grant.port,
    logging: false,
    pool: { max: 1, min: 0 },
    dialectOptions: { application_name: f.report.ownerMarker, statement_timeout: 60000 },
  });
  const bridge = await import(
    pathToFileURL(path.join(current, '20260813110000-preserve-status-ingress-receipts.js')).href
  );
  const saved = process.env.EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER;
  const query = (sql, bind = []) => db.query(sql, { bind });
  try {
    delete process.env.EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER;
    await assert.rejects(bridge.up(db.getQueryInterface()), /Stop all writers/);
    process.env.EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER = 'acknowledged';
    await query(
      `UPDATE "OCPPMessages" SET message='[2,"wrong-id","StatusNotification",{}]'::jsonb WHERE id=94001`,
    );
    await assert.rejects(bridge.up(db.getQueryInterface()), /STATUS_INGRESS_INVALID_SOURCE_ROWS/);
    const [absent] = await query(`SELECT to_regclass('public."StatusIngressReceipts"') relation`);
    assert.equal(absent[0].relation, null, 'failed preflight must roll back table creation');
    const [oldFK] = await query(
      `SELECT confrelid::regclass::text target FROM pg_constraint WHERE conrelid='"StatusNotifications"'::regclass AND contype='f' AND confrelid='"OCPPMessages"'::regclass`,
    );
    assert.equal(oldFK.length, 1, 'failed bridge retains original witness FK');
    await query('UPDATE "OCPPMessages" SET message=$1::jsonb WHERE id=94001', [
      JSON.stringify(frame),
    ]);
    await query('UPDATE "OCPPMessages" SET "statusIngressConnection"=NULL WHERE id=94001');
    await assert.rejects(
      bridge.up(db.getQueryInterface()),
      /STATUS_INGRESS_MISSING_OR_CROSS_TENANT_WITNESS/,
    );
    await query('UPDATE "OCPPMessages" SET "statusIngressConnection"=$1 WHERE id=94001', [
      connection,
    ]);
    await query(
      `INSERT INTO "Tenants" (id,name,"createdAt","updatedAt") VALUES (90002,'SYNTHETIC-NEGATIVE-TENANT',now(),now())`,
    );
    await query('UPDATE "OCPPMessages" SET "tenantId"=90002 WHERE id=94001');
    await assert.rejects(bridge.up(db.getQueryInterface()), /STATUS_INGRESS_INVALID_SOURCE_ROWS/);
    await query('UPDATE "OCPPMessages" SET "tenantId"=1 WHERE id=94001');
    await bridge.up(db.getQueryInterface());
    await query(
      `UPDATE "StatusIngressReceipts" SET frame='[2,"corrupted","StatusNotification",{}]'::jsonb WHERE id=94001`,
    );
    await assert.rejects(bridge.up(db.getQueryInterface()), /STATUS_INGRESS_RECEIPT_ID_CONFLICT/);
    await query('UPDATE "StatusIngressReceipts" SET frame=$1::jsonb WHERE id=94001', [
      JSON.stringify(frame),
    ]);
    await bridge.up(db.getQueryInterface());
    await bridge.up(db.getQueryInterface());
    const [rows] = await query('SELECT frame FROM "StatusIngressReceipts" WHERE id=94001');
    assert.deepEqual(rows[0].frame, frame);
    f.report.assertions.push({
      name: 'real-bridge-negative-preflight',
      cases: [
        'acknowledgement absent rejects',
        'invalid original identity rejects before swap',
        'DDL rollback preserves old FK',
        'same ID with divergent content rejects',
        'exact identity repeat succeeds without duplicate witness',
        'missing receipt source rejects before swap',
        'cross-tenant station/source reference rejects',
      ],
    });
  } finally {
    if (saved === undefined) delete process.env.EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER;
    else process.env.EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER = saved;
    await db.close();
  }
  await f.quiescent(name);
}
async function exerciseReceipts(f, name) {
  f.guard('built-DAL-receipts');
  const types = await import(pathToFileURL(path.join(f.root, 'packages/types/dist/index.js')).href);
  const dal = await import(pathToFileURL(path.join(f.root, 'packages/dal/dist/index.js')).href);
  const models = await import(
    pathToFileURL(path.join(f.root, 'packages/dal/dist/src/models/location/index.js')).href
  );
  const config = types.configSchema.parse({
    env: 'development',
    swagger: { path: '/docs', logoPath: '/tmp/synthetic-logo.png', exposeMessage: false },
    integrations: {
      v2gCA: {},
      chargingStationCA: { acme: { accountKeyFilePath: '/tmp/synthetic-acme.pem' } },
    },
    database: {
      host: f.grant.host,
      port: f.grant.port,
      database: name,
      username: f.grant.user,
      password: f.grant.password,
      pool: { max: 2, min: 0, acquire: 3000, idle: 100 },
    },
  });
  const sequelize = dal.DefaultSequelizeInstance.getInstance(config);
  try {
    await sequelize.authenticate();
    const ingress = new dal.SequelizeStatusIngressRepository({
      config,
      sequelizeInstance: sequelize,
    });
    const station = await models.ChargingStation.create({
      tenantId: 1,
      ocppConnectionName: 'SYNTHETIC-ORDER',
      protocol: 'ocpp1.6',
      statusIngressConnection: connection,
      use16StatusNotification0: true,
    });
    const evse = await models.Evse.create({ tenantId: 1, stationId: station.id, evseTypeId: 1 });
    const first = await models.Connector.create({
      tenantId: 1,
      stationId: station.id,
      evseId: evse.id,
      connectorId: 1,
      evseTypeConnectorId: 1,
      status: 'Charging',
      timestamp: '2026-11-07T11:59:00.000Z',
    });
    const second = await models.Connector.create({
      tenantId: 1,
      stationId: station.id,
      evseId: evse.id,
      connectorId: 2,
      evseTypeConnectorId: 2,
      status: 'Charging',
      timestamp: '2026-11-07T11:59:00.000Z',
    });
    const zero = await models.Connector.create({
      tenantId: 1,
      stationId: station.id,
      evseId: evse.id,
      connectorId: 0,
      status: 'Charging',
      timestamp: '2026-11-07T11:59:00.000Z',
    });
    const at = '2026-11-07T12:00:00.000Z';
    async function reserve(correlationId, payload, protocol = 'ocpp1.6', socket = connection) {
      const id = await ingress.reserve(
        1,
        station.ocppConnectionName,
        socket,
        correlationId,
        protocol,
        [2, correlationId, 'StatusNotification', payload],
        new Date(at),
      );
      return { messageId: id, connection: socket, correlationId, protocol };
    }
    function status(payload) {
      return {
        tenantId: 1,
        stationId: station.id,
        evseId: 1,
        connectorId: payload.connectorId,
        connectorStatus: payload.status ?? payload.connectorStatus,
        timestamp: payload.timestamp,
      };
    }
    function connector(row, payload) {
      return {
        ...row.get(),
        status: payload.status ?? payload.connectorStatus,
        timestamp: payload.timestamp,
      };
    }
    const finishing = { connectorId: 1, status: 'Finishing', errorCode: 'NoError', timestamp: at };
    const available = { ...finishing, status: 'Available' };
    const old = await reserve('first', finishing);
    const newer = await reserve('second', available);
    assert.ok(newer.messageId > old.messageId);
    const applied = await ingress.apply(
      1,
      station.ocppConnectionName,
      status(available),
      connector(first, available),
      available,
      newer,
    );
    assert.equal(applied.applied, true);
    assert.equal(
      (
        await ingress.apply(
          1,
          station.ocppConnectionName,
          status(finishing),
          connector(first, finishing),
          finishing,
          old,
        )
      ).applied,
      false,
    );
    await first.reload();
    assert.equal(first.status, 'Available');
    const beforeReplay = await models.StatusNotification.count({
      where: { tenantId: 1, stationId: station.id },
    });
    assert.equal(
      (
        await ingress.apply(
          1,
          station.ocppConnectionName,
          status(available),
          connector(first, available),
          available,
          newer,
        )
      ).applied,
      false,
    );
    assert.equal(
      await models.StatusNotification.count({ where: { tenantId: 1, stationId: station.id } }),
      beforeReplay,
    );
    assert.equal((await reserve('second', available)).messageId, newer.messageId);
    await assert.rejects(reserve('second', finishing), /STATUS_INGRESS_IDENTITY_REUSED/);
    await assert.rejects(
      ingress.apply(
        1,
        station.ocppConnectionName,
        status(finishing),
        connector(first, finishing),
        finishing,
        newer,
      ),
      /STATUS_INGRESS_RECEIPT_MISMATCH/,
    );
    const newestSecond = { ...available, connectorId: 2, timestamp: '2026-11-07T12:02:00Z' };
    await ingress.apply(
      1,
      station.ocppConnectionName,
      status(newestSecond),
      connector(second, newestSecond),
      newestSecond,
      await reserve('physical-2', newestSecond),
    );
    const broadcast = {
      connectorId: 0,
      status: 'Unavailable',
      errorCode: 'NoError',
      timestamp: '2026-11-07T12:01:00Z',
    };
    const broad = await reserve('broadcast', broadcast);
    const result = await ingress.apply(
      1,
      station.ocppConnectionName,
      status(broadcast),
      {
        status: 'Unavailable',
        timestamp: broadcast.timestamp,
        stationId: station.id,
        evseId: evse.id,
      },
      broadcast,
      broad,
      true,
    );
    assert.equal(result.observations.length, 1);
    await first.reload();
    await second.reload();
    await zero.reload();
    assert.equal(first.status, 'Unavailable');
    assert.equal(second.status, 'Available');
    assert.equal(zero.status, 'Charging');
    assert.equal(
      await models.StatusNotification.count({ where: { ingressMessageId: broad.messageId } }),
      3,
      'one broadcast fact plus two physical observations',
    );
    assert.equal(
      (
        await ingress.apply(
          1,
          station.ocppConnectionName,
          status(broadcast),
          undefined,
          broadcast,
          broad,
          true,
        )
      ).applied,
      false,
    );
    const devices = await import(
      pathToFileURL(path.join(f.root, 'packages/dal/dist/src/models/device-model/index.js')).href
    );
    const component = await devices.Component.create({ tenantId: 1, name: 'SYNTHETIC-EVSE' });
    const variable = await devices.Variable.create({ tenantId: 1, name: 'AvailabilityState' });
    const effectPayload = {
      ...available,
      status: 'Unavailable',
      timestamp: '2026-11-07T12:02:30.000Z',
    };
    const effectReceipt = await reserve('device-effect', effectPayload);
    const factCount = await models.StatusNotification.count({ where: { stationId: station.id } });
    await first.reload();
    const previousPointer = first.latestStatusNotificationId;
    const effect = {
      componentId: component.id,
      variableId: variable.id,
      value: 'Unavailable',
      generatedAt: effectPayload.timestamp,
    };
    await assert.rejects(
      ingress.apply(
        1,
        station.ocppConnectionName,
        status(effectPayload),
        connector(first, effectPayload),
        effectPayload,
        effectReceipt,
        false,
        [{ ...effect, variableId: -2147483647 }],
      ),
      (error) => error.original?.code === '23503',
    );
    await first.reload();
    assert.equal(
      first.latestStatusNotificationId,
      previousPointer,
      'failed effect rolls back projection',
    );
    assert.equal(
      await models.StatusNotification.count({ where: { stationId: station.id } }),
      factCount,
      'failed effect rolls back status fact',
    );
    assert.equal(await devices.VariableAttribute.count({ where: { stationId: station.id } }), 0);
    assert.equal(
      (
        await ingress.apply(
          1,
          station.ocppConnectionName,
          status(effectPayload),
          connector(first, effectPayload),
          effectPayload,
          effectReceipt,
          false,
          [effect],
        )
      ).applied,
      true,
    );
    assert.equal(
      (
        await devices.VariableAttribute.findOne({
          where: { stationId: station.id, componentId: component.id, variableId: variable.id },
        })
      ).value,
      'Unavailable',
    );
    f.report.assertions.push({
      name: 'device-effects-atomicity',
      cases: [
        'real FK failure rolls back fact and connector pointer',
        'same receipt retries after rollback',
        'availability attribute commits with winning projection',
      ],
    });
    const retired = { ...available, timestamp: '2026-11-07T12:03:00Z' };
    const retiredId = await reserve('retired', retired);
    const replacement = '00000000-0000-4000-8000-000000000002';
    await ingress.setConnection(1, station.ocppConnectionName, replacement, async () => true);
    await assert.rejects(reserve('retired-new', retired), /STATUS_INGRESS_RETIRED_CONNECTION/);
    assert.equal(
      (
        await ingress.apply(
          1,
          station.ocppConnectionName,
          status(retired),
          connector(first, retired),
          retired,
          retiredId,
        )
      ).applied,
      false,
    );
    await assert.rejects(
      ingress.setConnection(1, station.ocppConnectionName, connection, async () => false),
      /STATUS_INGRESS_RETIRED_REGISTRATION/,
    );
    await first.reload();
    assert.equal(first.status, 'Unavailable');
    const location = new dal.SequelizeLocationRepository({ config, sequelizeInstance: sequelize });
    await assert.rejects(
      sequelize.transaction(async (transaction) => {
        await location.connector.updateAllByQuery(
          1,
          { status: 'Faulted' },
          { where: { id: first.id }, transaction },
        );
        throw new Error('rollback fixture');
      }),
      /rollback fixture/,
    );
    await first.reload();
    assert.equal(first.status, 'Unavailable');
    const sequences = new dal.SequelizeChargingStationSequenceRepository({
      config,
      sequelizeInstance: sequelize,
    });
    const values = await Promise.all(
      [1, 2].map(() =>
        sequelize.transaction((transaction) =>
          sequences.getNextSequenceValue(
            1,
            station.ocppConnectionName,
            'transactionId',
            transaction,
          ),
        ),
      ),
    );
    assert.equal(
      new Set(values).size,
      2,
      'bounded pool sequence allocation shares caller transaction',
    );
    const { SequelizeChargingCalloutStore } = await import(
      pathToFileURL(
        path.join(
          f.root,
          'packages/ocpp/dist/src/services/authorizer/SequelizeChargingCalloutStore.js',
        ),
      ).href
    );
    const store = new SequelizeChargingCalloutStore({ config, sequelizeInstance: sequelize });
    const key = {
      tenantId: 1,
      ocppConnectionName: station.ocppConnectionName,
      authorizationId: 42,
      connectorId: first.id,
    };
    const now = new Date();
    const begun = await Promise.all([
      store.begin(key, now, 1000, 30000),
      store.begin(key, now, 1000, 30000),
    ]);
    assert.equal(begun[0].kind, 'CALLOUT');
    assert.equal(begun[0].ref, begun[1].ref, 'database advisory lock mints one callout');
    assert.equal(await store.markDeclined(begun[0].ref, 'core-decision:synthetic-pg', now), true);
    assert.equal(
      await store.markAuthorized(begun[0].ref, now),
      false,
      'late acceptance cannot reverse durable decline',
    );
    const restarted = new SequelizeChargingCalloutStore({ config, sequelizeInstance: sequelize });
    assert.equal((await restarted.begin(key, now, 1000, 30000)).kind, 'FENCED_DECLINED');
    const other = await restarted.begin({ ...key, tenantId: 2 }, now, 1000, 30000);
    assert.equal(other.kind, 'CALLOUT');
    assert.notEqual(other.ref, begun[0].ref, 'tenant does not share admission fence');
    f.report.assertions.push({
      name: 'actual-postgres-admission-ledger',
      cases: [
        'concurrent single ref',
        'durable decline CAS',
        'late authorization fenced',
        'restart recovery',
        'tenant isolation',
      ],
    });
    const receiptOwner = await models.ChargingStation.create({
      tenantId: 1,
      ocppConnectionName: 'SYNTHETIC-RECEIPT-ONLY-OWNER',
      protocol: 'ocpp1.6',
      statusIngressConnection: connection,
    });
    await ingress.reserve(
      1,
      receiptOwner.ocppConnectionName,
      connection,
      'owner-only',
      'ocpp1.6',
      [2, 'owner-only', 'StatusNotification', available],
      new Date(at),
    );
    assert.equal(await models.Connector.count({ where: { stationId: receiptOwner.id } }), 0);
    assert.equal(await models.Evse.count({ where: { stationId: receiptOwner.id } }), 0);
    await assert.rejects(
      receiptOwner.destroy(),
      (error) =>
        error.original?.code === '23503' &&
        error.original?.constraint === 'StatusIngressReceipts_stationId_fkey',
    );
    f.report.assertions.push({
      name: 'actual-built-DAL',
      cases: [
        'socket receipt identity and original order',
        'reversed completion',
        'whole receipt replay',
        'divergent reuse',
        'partial broadcast wins and connector zero exclusion',
        'retired socket suppression',
        'registration fence',
        'caller rollback',
        'bounded sequence pool',
        'receipt-only owner deletion exact StatusIngressReceipts_stationId_fkey',
      ],
    });
  } finally {
    await sequelize.close();
  }
}
async function exercisePartitionIdentityAndRetention(f, name, frame) {
  f.guard('partition-identity-retention');
  const db = await f.connect(name);
  try {
    await db.query(
      `INSERT INTO "OCPPMessages" (id,"tenantId","stationId","correlationId",origin,state,protocol,action,message,raw,timestamp,"createdAt","updatedAt")
      VALUES (94001,1,90001,'old-bound-call','cs','1','ocpp1.6','StatusNotification',$1::jsonb,$2,'2020-01-01',date_trunc('week',now())-interval '6 days',now())`,
      [JSON.stringify(frame), JSON.stringify(frame)],
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM "OCPPMessages" WHERE id=94001')).rows[0].n,
      1,
    );
    await db.query('CALL rotate_ocpp_messages_partitions(1,0,false)');
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM "OCPPMessages" WHERE id=94001')).rows[0].n,
      0,
    );
    assert.deepEqual(
      (await db.query('SELECT frame FROM "StatusIngressReceipts" WHERE id=94001')).rows[0].frame,
      frame,
    );
    assert.equal(
      (await db.query('SELECT "ingressMessageId" FROM "StatusNotifications" WHERE id=95001'))
        .rows[0].ingressMessageId,
      94001,
    );
    await db.query(`INSERT INTO "Transactions" (id,"tenantId","createdAt","updatedAt","isActive") VALUES
      (191001,1,date_trunc('day',now()),now(),false),
      (191001,1,date_trunc('day',now())+interval '1 hour',now(),false)`);
    await db.query(`INSERT INTO "StartTransactions" ("transactionDatabaseId","transactionCreatedAt","tenantId","createdAt","updatedAt")
      SELECT id,"createdAt",1,now(),now() FROM "Transactions" WHERE id=191001`);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int n FROM "StartTransactions" WHERE "transactionDatabaseId"=191001',
        )
      ).rows[0].n,
      2,
    );
    await assert.rejects(
      db.query(`INSERT INTO "StartTransactions" ("transactionDatabaseId","transactionCreatedAt","tenantId","createdAt","updatedAt")
      VALUES (191001,date_trunc('day',now())+interval '2 hours',1,now(),now())`),
      (error) => error.code === '23503',
    );
    await db.query(
      `DELETE FROM "Transactions" WHERE id=191001 AND "createdAt"=date_trunc('day',now())`,
    );
    assert.equal(
      (await db.query('SELECT count(*)::int n FROM "Transactions" WHERE id=191001')).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int n FROM "StartTransactions" WHERE "transactionDatabaseId"=191001',
        )
      ).rows[0].n,
      1,
      'composite FK deletion leaves other same-id transaction child',
    );
    await db.query(`INSERT INTO "Transactions" (id,"tenantId","stationId","transactionId","createdAt","updatedAt","isActive")
      VALUES (193001,1,90001,'synthetic-protocol-key',now(),now(),false)`);
    await assert.rejects(
      db.query(`INSERT INTO "Transactions" (id,"tenantId","stationId","transactionId","createdAt","updatedAt","isActive")
      VALUES (193002,1,90001,'synthetic-protocol-key',now()+interval '1 hour',now(),false)`),
      (error) => error.code === '23505',
    );
    f.report.assertions.push({
      name: 'real-partition-retention-composite-identity',
      cases: [
        'actual old message partition dropped by retention procedure',
        'receipt/frame and projection FK survive',
        'same numeric transaction id with distinct createdAt',
        'child requires exact composite parent',
        'delete one composite parent leaves other identity and child',
        'station protocol TransactionKeys duplicate rejects',
      ],
    });
  } finally {
    await db.end();
  }
}
(async () => {
  const f = makeFixture(loadGrant());
  let success = false;
  try {
    const current = path.join(f.root, 'apps/ocpp-server/dist/migrations');
    assert.ok(fs.existsSync(current), 'Parent must build actual migration sources first');
    const sourceDirectory = path.join(f.root, 'apps/ocpp-server/db/migrations');
    const sourceFiles = fs
      .readdirSync(sourceDirectory)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    const emittedFiles = fs
      .readdirSync(current)
      .filter((name) => name.endsWith('.js'))
      .sort();
    assert.deepEqual(
      emittedFiles,
      sourceFiles.map((name) => name.replace(/\.ts$/, '.js')),
      'Actual CLI discovery must contain exactly active source migrations, no stale retired outputs',
    );
    f.report.currentMigrationSources = sourceFiles.map((name) => ({
      filename: name,
      sourceSha256: require('./database-fixture.cjs').sha(
        fs.readFileSync(path.join(sourceDirectory, name)),
      ),
      emittedSha256: require('./database-fixture.cjs').sha(
        fs.readFileSync(path.join(current, name.replace(/\.ts$/, '.js'))),
      ),
    }));
    const fresh = await f.create('fresh');
    const currentNames = await f.migrate(fresh, current, 'fresh');
    assert.ok(currentNames.includes('20260813110000-preserve-status-ingress-receipts.js'));
    assert.ok(!currentNames.includes('20261020210000-bind-status-ingress.js'));
    await f.migrationProof(fresh, 'fresh', [], currentNames);
    const legacy = await f.create('legacy');
    const oldPath = await f.prepareLegacy();
    const oldNames = await f.migrate(legacy, oldPath, 'legacy');
    assert.equal(oldNames.length, 52);
    const before = await f.connect(legacy);
    let frame;
    try {
      frame = await baselineRows(before);
    } finally {
      await before.end();
    }
    const backup = await f.dump(legacy);
    const recovered = await f.create('recovered');
    await f.restore(recovered, backup);
    const restored = await f.connect(recovered);
    try {
      assert.deepEqual(
        (await restored.query('SELECT name FROM "SequelizeMeta" ORDER BY name')).rows.map(
          (r) => r.name,
        ),
        oldNames,
      );
      assert.deepEqual(
        (await restored.query('SELECT message FROM "OCPPMessages" WHERE id=94001')).rows[0].message,
        frame,
      );
      assert.equal(
        (
          await restored.query(
            'SELECT "ingressMessageId" FROM "StatusNotifications" WHERE id=95001',
          )
        ).rows[0].ingressMessageId,
        94001,
      );
    } finally {
      await restored.end();
    }
    await exerciseBridgePreflight(f, legacy, current, frame);
    const afterNames = await f.migrate(legacy, current, 'upgrade');
    for (const name of oldNames)
      assert.ok(afterNames.includes(name), 'Never fabricate/remove recorded original history');
    const upgraded = await f.connect(legacy);
    try {
      assert.deepEqual(
        (await upgraded.query('SELECT frame FROM "StatusIngressReceipts" WHERE id=94001')).rows[0]
          .frame,
        frame,
      );
      assert.equal(
        (
          await upgraded.query(
            'SELECT "latestStatusNotificationId" FROM "Connectors" WHERE id=90001',
          )
        ).rows[0].latestStatusNotificationId,
        95001,
      );
      assert.equal(
        (await upgraded.query('SELECT count(*)::int n FROM "OCPPMessages" WHERE id=94001')).rows[0]
          .n,
        0,
        'outside-retention frame is not in live partitions',
      );
      assert.deepEqual(
        (await upgraded.query('SELECT message FROM "OCPPMessages_old" WHERE id=94001')).rows[0]
          .message,
        frame,
      );
      assert.equal(
        (
          await upgraded.query(
            'SELECT "ingressMessageId" FROM "StatusNotifications" WHERE id=95001',
          )
        ).rows[0].ingressMessageId,
        94001,
      );
    } finally {
      await upgraded.end();
    }
    assert.deepEqual(await f.migrate(legacy, current, 'repeat-discovery'), afterNames);
    await f.migrationProof(legacy, 'upgraded', oldNames, afterNames);
    f.report.assertions.push({
      name: 'migration-history-and-recovery',
      baselineMigrationCount: oldNames.length,
      finalMigrationCount: afterNames.length,
      cases: [
        'fresh active discovery',
        'actual original migration history',
        'out-of-retention witness copied before swap',
        'original witness ID and frame',
        'latest connector pointer',
        'retired stored names tolerated',
        'repeat discovery idempotent',
        'offline pre-upgrade dump restored exact schema/history/witness',
      ],
    });
    await exercisePartitionIdentityAndRetention(f, legacy, frame);
    await exerciseReceipts(f, fresh);
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
