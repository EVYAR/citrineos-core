// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Sequelize } from 'sequelize-typescript';
import { setTimeout as delay } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Logger } from 'tslog';
import type {
  ChargingAdmissionProvenance,
  ChargingAdmissionWithdrawalRequest,
  SystemConfig,
} from '@citrineos/types';
import { OCPP2_0_1 } from '@citrineos/types';
import { DefaultSequelizeInstance } from '../../src/db/sequelize/util.js';
import { SequelizeTransactionEventRepository } from '../../src/repositories/sequelize/transaction-event.js';
import { DrizzleTransactionRepository } from '../../src/repositories/drizzle/transaction.js';
import { ChargingAdmissionWithdrawalService } from '../../../../packages/ocpp/src/services/authorizer/charging-admission-withdrawal-service.js';

// Deliberately no sync(), hand-made DDL, migration imports, business URL fallback,
// container auto-provisioning or truncation. The owner supplies a NEW official-
// migrated, explicitly marked disposable fixture and destroys it after this suite.
const optedIn = process.env.CHARGING_ADMISSION_PG_OPT_IN === 'isolated-official-migrations-v1';

describe.runIf(optedIn)('charging admission withdrawal: official migrated PostgreSQL', () => {
  let pool: Pool;
  let sequelize: Sequelize;
  let service: ChargingAdmissionWithdrawalService;
  let config: SystemConfig;
  const logger = new Logger({ minLevel: 6 });

  beforeAll(async () => {
    const url = new URL(process.env.CHARGING_ADMISSION_PG_FIXTURE_URL ?? '');
    const marker = process.env.CHARGING_ADMISSION_PG_FIXTURE_MARKER ?? '';
    assert.match(url.protocol, /^postgres(?:ql)?:$/);
    assert.match(url.pathname, /^\/charging_admission_fixture_[a-f0-9]{16}$/);
    assert.equal(decodeURIComponent(url.username), url.pathname.slice(1));
    assert.match(marker, /^charging-admission-fixture:[a-f0-9]{32}$/);
    assert.ok(url.password.length >= 32);
    pool = new Pool({ connectionString: url.href, max: 8, application_name: 'charging-admission-isolated-tests' });
    const identity = (await pool.query(`SELECT current_database() AS db, current_user AS role,
      shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)).rows[0];
    assert.equal(identity.db, url.pathname.slice(1));
    assert.equal(identity.role, decodeURIComponent(url.username));
    assert.equal(identity.marker, marker);
    const migrations = (await pool.query('SELECT name FROM "SequelizeMeta"')).rows.map((r) => r.name as string);
    assert.ok(migrations.some((name) => /^20261116000000-charging-admission-withdrawals\.(?:js|ts)$/.test(name)));
    for (const table of ['Transactions', 'TransactionKeys', 'ChargingAdmissionCallouts', 'ChargingAdmissionWithdrawals', 'ChargingAdmissionConsumptions']) {
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n), 0, `Fixture must be fresh: ${table}`);
    }
    config = {
      database: {
        host: url.hostname, port: Number(url.port || 5432), database: identity.db,
        username: identity.role, password: decodeURIComponent(url.password), dialect: 'postgres',
        sync: false, alter: false, force: false,
      },
      realTimeAuthChargingCallouts: { enabled: true },
    } as SystemConfig;
    sequelize = DefaultSequelizeInstance.getInstance(config, logger);
    service = new ChargingAdmissionWithdrawalService({ config, logger, sequelizeInstance: sequelize });
  }, 30_000);

  afterAll(async () => {
    if (sequelize) await sequelize.close();
    if (pool) await pool.end();
  });

  interface Scenario {
    tenantId: number; stationId: number; native: number; commercial: number;
    evseId: number; authorizationId: number; connection: string; token: string;
    callout: string; legacy: { id: number; createdAt: Date };
    body: ChargingAdmissionWithdrawalRequest;
  }
  type Db = Pool | PoolClient;

  async function nativeRow(s: Scenario, db: Db = pool, connector = s.native) {
    return (await db.query(`INSERT INTO "Transactions"
      ("tenantId","stationId","connectorId","authorizationId","evseId","transactionId","isActive","startTime","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,true,clock_timestamp(),date_trunc('milliseconds',clock_timestamp()),clock_timestamp()) RETURNING id,"createdAt"`,
    [s.tenantId, s.stationId, connector, s.authorizationId, s.evseId, randomUUID()])).rows[0] as { id: number; createdAt: Date };
  }
  async function startRow(s: Scenario, tx: { id: number; createdAt: Date }, db: Db = pool, connector = s.native) {
    return db.query(`INSERT INTO "StartTransactions"
      ("tenantId","ocppConnectionName","transactionDatabaseId","transactionCreatedAt","connectorDatabaseId","meterStart",timestamp,"createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,1000,clock_timestamp(),clock_timestamp(),clock_timestamp()) RETURNING id`,
    [s.tenantId, s.connection, tx.id, tx.createdAt, connector]);
  }
  async function callout(s: Pick<Scenario, 'tenantId' | 'connection' | 'authorizationId' | 'native'>, requestedAt?: Date) {
    const ref = randomUUID();
    await pool.query(`INSERT INTO "ChargingAdmissionCallouts"
      (id,"tenantId","ocppConnectionName","authorizationId","connectorId",state,"requestedAt","decidedAt","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'AUTHORIZED',COALESCE($6::timestamptz,clock_timestamp()),date_trunc('milliseconds',clock_timestamp()),clock_timestamp(),clock_timestamp())`,
    [ref, s.tenantId, s.connection, s.authorizationId, s.native, requestedAt ?? null]);
    return ref;
  }
  async function scenario(): Promise<Scenario> {
    const tenantId = (await pool.query('INSERT INTO "Tenants" (id,name,"createdAt","updatedAt") SELECT COALESCE(max(id),0)+1,$1,now(),now() FROM "Tenants" RETURNING id', [randomUUID()])).rows[0].id as number;
    const connection = `withdraw-${randomUUID().slice(0, 20)}`;
    const stationId = (await pool.query(`INSERT INTO "ChargingStations" ("tenantId","ocppConnectionName",protocol,"createdAt","updatedAt") VALUES ($1,$2,'ocpp1.6',now(),now()) RETURNING id`, [tenantId, connection])).rows[0].id as number;
    const evseId = (await pool.query(`INSERT INTO "Evses" ("tenantId","stationId","evseTypeId","createdAt","updatedAt") VALUES ($1,$2,1,now(),now()) RETURNING id`, [tenantId, stationId])).rows[0].id as number;
    const connectors = (await pool.query(`INSERT INTO "Connectors" ("tenantId","stationId","evseId","connectorId","evseTypeConnectorId","createdAt","updatedAt") VALUES ($1,$2,$3,1,1,now(),now()),($1,$2,$3,2,2,now(),now()) RETURNING id,"connectorId"`, [tenantId, stationId, evseId])).rows;
    const token = randomUUID();
    const authorizationId = (await pool.query(`INSERT INTO "Authorizations" ("tenantId","idToken","idTokenType",status,"createdAt","updatedAt") VALUES ($1,$2,'ISO14443','Accepted',now(),now()) RETURNING id`, [tenantId, token])).rows[0].id as number;
    const s = { tenantId, stationId, evseId, connection, token, authorizationId,
      native: connectors.find((r) => r.connectorId === 2)!.id as number,
      commercial: connectors.find((r) => r.connectorId === 1)!.id as number } as Scenario;
    // Genuine independent native history exists BEFORE the callout; no causal
    // join is inferred. The legacy session deliberately has no authorization.
    s.legacy = await nativeRow(s);
    await pool.query('UPDATE "Transactions" SET "authorizationId"=NULL WHERE id=$1 AND "createdAt"=$2', [s.legacy.id, s.legacy.createdAt]);
    await startRow(s, s.legacy);
    await pool.query(`INSERT INTO "StopTransactions" ("tenantId","ocppConnectionName","transactionDatabaseId","transactionCreatedAt","meterStop",timestamp,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,1000,clock_timestamp(),clock_timestamp(),clock_timestamp())`, [tenantId, connection, s.legacy.id, s.legacy.createdAt]);
    await pool.query(`UPDATE "Transactions" t SET "isActive"=false,"endTime"=s.timestamp
      FROM "StopTransactions" s WHERE t.id=$1 AND t."createdAt"=$2
        AND s."transactionDatabaseId"=t.id AND s."transactionCreatedAt"=t."createdAt"`,
    [s.legacy.id, s.legacy.createdAt]);
    s.callout = await callout(s);
    s.body = { schemaVersion: '1.0.0', chargingCalloutRef: s.callout, idempotencyKey: randomUUID(),
      expectedCommercialTarget: { ocppConnectionName: connection, protocol: 'ocpp1.6', ocppEvseId: 1, ocppConnectorId: 1 } };
    return s;
  }
  function provenance(ref: string, requestId = randomUUID()): ChargingAdmissionProvenance {
    return { schemaVersion: '1.0.0', chargingCalloutRef: ref, nativeRequestId: requestId, nativeRequestHash: 'a'.repeat(64) };
  }
  async function consume(s: Scenario, tx: { id: number; createdAt: Date }, p: ChargingAdmissionProvenance, db: Db) {
    return db.query('SELECT charging_admission_consume($1,$2,$3,$4,$5,$6,$7::jsonb)', [s.tenantId, s.stationId, s.native, s.authorizationId, tx.id, tx.createdAt, JSON.stringify(p)]);
  }
  async function inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL statement_timeout='5s'");
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally { db.release(); }
  }
  async function originals(s: Scenario) {
    const result: Record<string, unknown> = {};
    for (const table of ['Transactions', 'StartTransactions', 'StopTransactions', 'ChargingAdmissionCallouts']) {
      result[table] = (await pool.query(`SELECT row_to_json(t)::text AS row FROM "${table}" t WHERE "tenantId"=$1 ORDER BY id`, [s.tenantId])).rows;
    }
    return result;
  }

  it('preserves original native serialization and AUTHORIZED decision; read/replay is immutable and tenant/actor/body bound', async () => {
    const s = await scenario();
    const before = await originals(s);
    const receipt = await service.withdraw(s.tenantId, s.body, 'adapter-owner');
    expect(receipt.causalCalloutTransactionBinding).toBe('NOT_ASSERTED_FOR_LEGACY_ROWS');
    expect(receipt.nativeSessions.map((r) => r.nativeTransaction.id)).toEqual([s.legacy.id]);
    expect(await originals(s)).toEqual(before);
    expect(await service.withdraw(s.tenantId, s.body, 'adapter-owner')).toEqual(receipt);
    expect(await service.read(s.tenantId, s.callout, 'adapter-owner')).toEqual(receipt);
    expect(await service.read(s.tenantId + 100000, s.callout, 'adapter-owner')).toBeNull();
    await expect(service.withdraw(s.tenantId, { ...s.body, idempotencyKey: randomUUID() }, 'adapter-owner')).rejects.toThrow();
    await expect(service.read(s.tenantId, s.callout, 'other-owner')).rejects.toThrow();
    for (const sql of [
      'UPDATE "ChargingAdmissionWithdrawals" SET "actorSubject"=\'changed\' WHERE "chargingCalloutRef"=$1',
      'DELETE FROM "ChargingAdmissionWithdrawals" WHERE "chargingCalloutRef"=$1',
      'UPDATE "ChargingAdmissionCallouts" SET state=\'DECLINED_BEFORE_POWER\' WHERE id=$1',
      'UPDATE "ChargingAdmissionCallouts" SET "declineAttempts"=1 WHERE id=$1',
      'DELETE FROM "ChargingAdmissionCallouts" WHERE id=$1',
    ]) await expect(pool.query(sql, [s.callout])).rejects.toThrow();
    expect(await originals(s)).toEqual(before);
  });

  it.each(['nonzero', 'active', 'missing-stop', 'retention-gap'] as const)('refuses independently unsafe native history: %s', async (kind) => {
    const s = await scenario();
    if (kind === 'nonzero') await pool.query('UPDATE "StopTransactions" SET "meterStop"=1001 WHERE "transactionDatabaseId"=$1', [s.legacy.id]);
    if (kind === 'active') await pool.query('UPDATE "Transactions" SET "isActive"=true WHERE id=$1', [s.legacy.id]);
    if (kind === 'missing-stop') await pool.query('DELETE FROM "StopTransactions" WHERE "transactionDatabaseId"=$1', [s.legacy.id]);
    if (kind === 'retention-gap') await pool.query('DELETE FROM "TransactionKeys" WHERE "transactionDatabaseId"=$1', [s.legacy.id]);
    await expect(service.withdraw(s.tenantId, s.body, 'adapter-owner')).rejects.toThrow();
    expect((await pool.query('SELECT count(*) AS n FROM "ChargingAdmissionWithdrawals" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('0');
  });

  it('rejects direct-SQL late/unlinked Start and Started on BOTH protected connectors, but not an unrelated station', async () => {
    const s = await scenario();
    const oldUnlinked = await nativeRow(s, pool, s.commercial);
    await pool.query('UPDATE "Transactions" SET "isActive"=false WHERE id=$1 AND "createdAt"=$2', [oldUnlinked.id, oldUnlinked.createdAt]);
    await service.withdraw(s.tenantId, s.body, 'adapter-owner');
    await expect(startRow(s, oldUnlinked, pool, s.commercial)).rejects.toThrow(/requires fresh same-transaction consumption/);
    for (const connector of [s.native, s.commercial]) {
      await expect(inTransaction(async (db) => startRow(s, await nativeRow(s, db, connector), db, connector))).rejects.toThrow(/requires fresh same-transaction consumption/);
      await expect(inTransaction(async (db) => {
        const tx = await nativeRow(s, db, connector);
        await db.query(`INSERT INTO "TransactionEvents" ("tenantId","ocppConnectionName","transactionDatabaseId","transactionCreatedAt","eventType",timestamp,"triggerReason","seqNo","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'Started',now(),'Authorized',0,now(),now())`, [s.tenantId, s.connection, tx.id, tx.createdAt]);
      })).rejects.toThrow(/requires fresh same-transaction consumption/);
    }
    const untouched = await scenario();
    await inTransaction(async (db) => startRow(untouched, await nativeRow(untouched, db), db));
  });

  it('rejects withdrawn/stale/divergent grants and rolls back both native row and consumption', async () => {
    const s = await scenario();
    const stale = await callout(s, new Date('2020-01-01T00:00:00Z'));
    await service.withdraw(s.tenantId, s.body, 'adapter-owner');
    for (const p of [provenance(s.callout), provenance(stale), { ...provenance(await callout(s)), nativeRequestHash: 'bad' }]) {
      await expect(inTransaction(async (db) => consume(s, await nativeRow(s, db), p, db))).rejects.toThrow();
    }
    const fresh = await callout(s);
    await expect(inTransaction(async (db) => {
      const tx = await nativeRow(s, db);
      await consume(s, tx, provenance(fresh), db);
      await startRow(s, tx, db, s.commercial); // deliberate identity divergence AFTER consumption
    })).rejects.toThrow(/connector diverged/);
    expect((await pool.query('SELECT count(*) AS n FROM "ChargingAdmissionConsumptions" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('0');
    expect((await pool.query('SELECT count(*) AS n FROM "Transactions" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('1');
    await expect(inTransaction(async (db) => {
      await db.query('UPDATE "Transactions" SET "updatedAt"=now() WHERE id=$1 AND "createdAt"=$2', [s.legacy.id, s.legacy.createdAt]);
      await consume(s, s.legacy, provenance(fresh), db);
    })).rejects.toThrow();
  });

  it('verifies provenance even on unaffected connectors and rejects deferred/replayed Starts', async () => {
    const s = await scenario();
    await expect(inTransaction(async (db) => {
      const tx = await nativeRow(s, db);
      await consume({ ...s, authorizationId: s.authorizationId + 100000 }, tx, provenance(s.callout), db);
    })).rejects.toThrow(/grant diverged/);
    const tx = await inTransaction(async (db) => {
      const native = await nativeRow(s, db);
      await consume(s, native, provenance(s.callout), db);
      return native;
    });
    await expect(startRow(s, tx)).rejects.toThrow(/consumption diverged/);
  });

  it('allows only one concurrent native Start to consume the same fresh callout', async () => {
    const s = await scenario();
    await service.withdraw(s.tenantId, s.body, 'adapter-owner');
    const ref = await callout(s);
    const results = await Promise.allSettled([1, 2].map(async () => inTransaction(async (db) => {
      const tx = await nativeRow(s, db);
      await consume(s, tx, provenance(ref), db);
      await startRow(s, tx, db);
    })));
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await pool.query('SELECT count(*) AS n FROM "ChargingAdmissionConsumptions" WHERE "chargingCalloutRef"=$1', [ref])).rows[0].n).toBe('1');
    expect((await pool.query('SELECT count(*) AS n FROM "Transactions" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('2');
  });

  it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)('preserves unaffected offline Starts at %s isolation', async (isolation) => {
    const s = await scenario();
    const db = await pool.connect();
    try {
      await db.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const tx = await nativeRow(s, db);
      const result = await startRow(s, tx, db);
      expect(result.rows).toHaveLength(1);
      await db.query('COMMIT');
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  it.each(['transaction', 'start'] as const)('rejects a withdrawal-stale REPEATABLE READ %s writer by guard-row serialization', async (write) => {
    const s = await scenario();
    const oldUnlinked = await nativeRow(s, pool, s.commercial);
    await pool.query('UPDATE "Transactions" SET "isActive"=false WHERE id=$1 AND "createdAt"=$2', [oldUnlinked.id, oldUnlinked.createdAt]);
    const db = await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const before = await db.query('SELECT revision FROM "ChargingAdmissionStationGuards" WHERE "stationId"=$1', [s.stationId]);
      expect(before.rows[0].revision).toBe('0');
      await service.withdraw(s.tenantId, s.body, 'adapter-owner');
      const latest = await pool.query('SELECT revision FROM "ChargingAdmissionStationGuards" WHERE "stationId"=$1', [s.stationId]);
      expect(latest.rows[0].revision).toBe('1');
      const pending = write === 'transaction'
        ? nativeRow(s, db)
        : startRow(s, oldUnlinked, db, s.commercial);
      await expect(pending).rejects.toMatchObject({ code: '40001' });
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  for (const engine of ['sequelize', 'drizzle'] as const) {
    for (const protocol of ['1.6', '2.x'] as const) {
      it(`allows a genuinely fresh ${protocol} intent through the real ${engine} DAL and rejects duplicate provenance`, async () => {
        const s = await scenario();
        await service.withdraw(s.tenantId, s.body, 'adapter-owner');
        const p = provenance(await callout(s));
        const repo = engine === 'sequelize'
          ? new SequelizeTransactionEventRepository({ config, logger, sequelizeInstance: sequelize })
          : new DrizzleTransactionRepository({ config, logger, drizzleInstance: drizzle(pool) });
        if (protocol === '2.x') {
          await expect(repo.createOrUpdateTransactionByTransactionEventAndStationId(s.tenantId, {
            eventType: OCPP2_0_1.TransactionEventEnumType.Started, timestamp: new Date().toISOString(),
            triggerReason: OCPP2_0_1.TriggerReasonEnumType.Authorized, seqNo: 0,
            transactionInfo: { transactionId: randomUUID() },
          }, s.connection)).rejects.toThrow(/requires fresh same-transaction consumption/);
        }
        const start = () => protocol === '1.6'
          ? repo.createTransactionByStartTransaction(s.tenantId, { connectorId: 2, idTag: s.token, meterStart: 1000, timestamp: new Date().toISOString() }, s.connection, p)
          : repo.createOrUpdateTransactionByTransactionEventAndStationId(s.tenantId, {
            eventType: OCPP2_0_1.TransactionEventEnumType.Started, timestamp: new Date().toISOString(),
            triggerReason: OCPP2_0_1.TriggerReasonEnumType.Authorized, seqNo: 0,
            transactionInfo: { transactionId: randomUUID() }, evse: { id: 1, connectorId: 2 },
            idToken: { idToken: s.token, type: OCPP2_0_1.IdTokenEnumType.ISO14443 },
          }, s.connection, p);
        const tx = await start();
        const consumption = (await pool.query('SELECT * FROM "ChargingAdmissionConsumptions" WHERE "chargingCalloutRef"=$1', [p.chargingCalloutRef])).rows;
        expect(consumption).toHaveLength(1);
        expect(consumption[0].transactionDatabaseId).toBe(tx.id);
        expect(consumption[0].snapshot.nativeRequestId).toBe(p.nativeRequestId);
        await expect(start()).rejects.toThrow();
        expect((await pool.query('SELECT count(*) AS n FROM "Transactions" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('2');
        await expect(pool.query('UPDATE "ChargingAdmissionConsumptions" SET "nativeRequestId"=\'changed\' WHERE "chargingCalloutRef"=$1', [p.chargingCalloutRef])).rejects.toThrow(/append-only/);
        await expect(pool.query('DELETE FROM "ChargingAdmissionConsumptions" WHERE "chargingCalloutRef"=$1', [p.chargingCalloutRef])).rejects.toThrow(/append-only/);
      });
    }
  }

  async function waitForBlocked(queryFragment: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const blocked = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 IN query)>0`, [queryFragment]);
      if (blocked.rowCount) return;
      // PostgreSQL lock waits are a real cross-process signal; fake JS timers
      // cannot advance the database. Poll the observed condition, never guess
      // a sleep duration as proof that either racing operation has progressed.
      await delay(10);
    }
    throw new Error(`Expected actual PostgreSQL lock wait: ${queryFragment}`);
  }

  it('serializes withdrawal behind in-flight native creation, then refuses its committed active Start', async () => {
    const s = await scenario();
    const writer = await pool.connect();
    let withdrawal: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL statement_timeout='10s'");
      const tx = await nativeRow(s, writer);
      await startRow(s, tx, writer);
      withdrawal = service.withdraw(s.tenantId, s.body, 'adapter-owner').then(
        (value) => ({ value }), (error: unknown) => ({ error }),
      );
      await waitForBlocked('LOCK TABLE "Transactions"');
      await writer.query('COMMIT');
      const result = await withdrawal as { error?: unknown };
      expect(result.error).toBeInstanceOf(Error);
      expect((await pool.query('SELECT count(*) AS n FROM "ChargingAdmissionWithdrawals" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('0');
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      if (withdrawal) await withdrawal;
    }
  });

  it('withdrawal-first race rejects a queued unlinked writer after the real owner commits', async () => {
    const s = await scenario();
    const owner = await pool.connect();
    let late: Promise<unknown> | undefined;
    let withdrawal: Promise<unknown> | undefined;
    try {
      await owner.query('BEGIN');
      // Pause the real service AFTER it obtains the complete-history SHARE
      // locks but BEFORE connector/callout validation. No service mock/hook.
      await owner.query('SELECT id FROM "ChargingStations" WHERE id=$1 FOR UPDATE', [s.stationId]);
      withdrawal = service.withdraw(s.tenantId, s.body, 'adapter-owner').then(
        (value) => ({ value }), (error: unknown) => ({ error }),
      );
      await waitForBlocked('SELECT id,protocol FROM "ChargingStations"');
      late = inTransaction(async (db) => startRow(s, await nativeRow(s, db), db)).then(
        (value) => ({ value }), (error: unknown) => ({ error }),
      );
      await waitForBlocked('INSERT INTO "Transactions"');
      await owner.query('COMMIT');
      const ownerResult = await withdrawal as { value?: unknown; error?: unknown };
      expect(ownerResult.error).toBeUndefined();
      expect(ownerResult.value).toBeDefined();
      const result = await late as { error?: unknown };
      expect(result.error).toBeInstanceOf(Error);
      expect((await pool.query('SELECT count(*) AS n FROM "StartTransactions" WHERE "tenantId"=$1', [s.tenantId])).rows[0].n).toBe('1');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
      if (withdrawal) await withdrawal;
      if (late) await late;
    }
  });
});
