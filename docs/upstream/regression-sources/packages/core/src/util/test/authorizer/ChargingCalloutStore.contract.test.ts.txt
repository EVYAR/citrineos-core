// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
// Store contract. Runs against the in-memory store always, and against Postgres when CORE_CALLOUT_PG_URL names a DISPOSABLE
// database (the actual migration creates/drops its new table; existing tables are refused). Guarded run:
//   CORE_CALLOUT_PG_URL=postgres://user:pw@host:5432/cgp_core_callout_test run-locked.sh ... vitest run ChargingCalloutStore.contract
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Sequelize } from 'sequelize-typescript';
import { ChargingAdmissionCallout } from '../../../dal/layers/sequelize/model/ChargingAdmissionCallout.js';
import { InMemoryChargingCalloutStore, type ChargingCalloutStore } from '../../authorizer/ChargingCalloutLedger.js';
import { SequelizeChargingCalloutStore } from '../../authorizer/SequelizeChargingCalloutStore.js';
import { up as migrateUp, down as migrateDown } from '../../../../../../apps/ocpp-server/migrations/20261019230000-create-charging-admission-callouts.js';

const PG = process.env.CORE_CALLOUT_PG_URL;
let sequelize: Sequelize | undefined;
let migrationApplied = false;
const key = (n = 0) => ({ tenantId: 1, ocppConnectionName: `CP-${n}`, authorizationId: 42, connectorId: 100 });

function suite(name: string, make: () => Promise<ChargingCalloutStore>) {
  describe(`ChargingCalloutStore: ${name}`, () => {
    it('mints one ref per request and reuses the pending one within the window', async () => {
      const s = await make();
      const a = await s.begin(key(1), new Date(), 6000, 30000);
      const b = await s.begin(key(1), new Date(), 6000, 30000);
      expect(a.kind).toBe('CALLOUT');
      expect(b).toEqual(a);
      const c = await s.begin(key(2), new Date(), 6000, 30000);
      expect(c.kind === 'CALLOUT' && a.kind === 'CALLOUT' && c.ref !== a.ref).toBe(true);
    });

    it('concurrent begin for the same request yields exactly one ref', async () => {
      const s = await make();
      const results = await Promise.all(Array.from({ length: 8 }, () => s.begin(key(3), new Date(), 6000, 30000)));
      expect(new Set(results.map((r) => r.ref)).size).toBe(1);
    });

    it('PENDING -> DECLINED is one-shot and fences a later authorization (the late-response guarantee)', async () => {
      const s = await make();
      const a = await s.begin(key(4), new Date(), 6000, 30000);
      expect(await s.markDeclined(a.ref, 'core-decision:one', new Date())).toBe(true);
      expect(await s.markAuthorized(a.ref, new Date())).toBe(false); // the late 8 s acceptance loses
      expect(await s.markDeclined(a.ref, 'core-decision:two', new Date())).toBe(false);
      const row = await s.get(a.ref);
      expect(row).toMatchObject({ state: 'DECLINED_BEFORE_POWER', coreEvidenceRef: 'core-decision:one' });
    });

    it('PENDING -> AUTHORIZED is one-shot and can no longer be declined', async () => {
      const s = await make();
      const a = await s.begin(key(5), new Date(), 6000, 30000);
      expect(await s.markAuthorized(a.ref, new Date())).toBe(true);
      expect(await s.markDeclined(a.ref, 'core-decision:x', new Date())).toBe(false);
      expect((await s.get(a.ref))!.state).toBe('AUTHORIZED');
    });

    it('reports an active decline fence and stops reporting it after the window', async () => {
      const s = await make();
      const t0 = new Date();
      const a = await s.begin(key(6), t0, 6000, 30000);
      await s.markDeclined(a.ref, 'core-decision:f', t0);
      expect(await s.begin(key(6), new Date(t0.getTime() + 5000), 6000, 30000)).toMatchObject({ kind: 'FENCED_DECLINED', ref: a.ref, coreEvidenceRef: 'core-decision:f' });
      const later = await s.begin(key(6), new Date(t0.getTime() + 31_000), 6000, 30000);
      expect(later.kind === 'CALLOUT' && later.ref !== a.ref).toBe(true);
    });

    it('lists only undelivered, non-abandoned declines and tracks delivery and failures', async () => {
      const s = await make();
      const t0 = new Date();
      const a = await s.begin(key(7), t0, 6000, 30000);
      const b = await s.begin(key(8), t0, 6000, 30000);
      await s.markDeclined(a.ref, 'core-decision:a', t0);
      await s.markDeclined(b.ref, 'core-decision:b', t0);
      expect((await s.dueDeclines(new Date(t0.getTime() + 1), 50)).map((r) => r.id).sort()).toEqual([a.ref, b.ref].sort());
      await s.markDeclineDelivered(a.ref, t0);
      await s.recordDeclineFailure(b.ref, 'ADAPTER_HTTP_404', new Date(t0.getTime() + 60_000), false);
      expect(await s.dueDeclines(new Date(t0.getTime() + 1), 50)).toHaveLength(0);
      expect((await s.dueDeclines(new Date(t0.getTime() + 61_000), 50)).map((r) => r.id)).toEqual([b.ref]);
      await s.recordDeclineFailure(b.ref, 'ADAPTER_HTTP_404', null, true);
      expect(await s.dueDeclines(new Date(t0.getTime() + 999_000), 50)).toHaveLength(0);
      expect((await s.get(b.ref))!.declineAttempts).toBe(2);
    });
  });
}

suite('in-memory', async () => new InMemoryChargingCalloutStore());

if (PG) {
  beforeAll(async () => {
    const target = new URL(PG);
    if (!/^\/cgp_core_callout_test(?:_[a-z0-9]+)?$/.test(target.pathname) || target.username !== 'cgp') {
      throw new Error('Core callout contract requires an explicit disposable cgp task database');
    }
    sequelize = new Sequelize(PG, { logging: false, models: [ChargingAdmissionCallout] });
    const [existing] = await sequelize.query(`SELECT to_regclass('"ChargingAdmissionCallouts"') AS relation`);
    if ((existing[0] as { relation: string | null }).relation !== null) {
      throw new Error('Refusing to replace an existing Core callout table');
    }
    await migrateUp(sequelize.getQueryInterface());
    migrationApplied = true;
    const [indexes] = await sequelize.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'ChargingAdmissionCallouts'`);
    expect(indexes.map(row => (row as { indexname: string }).indexname)).toEqual(expect.arrayContaining([
      'ChargingAdmissionCallouts_request_idx', 'ChargingAdmissionCallouts_undelivered_idx',
    ]));
  });
  afterAll(async () => {
    try {
      if (migrationApplied && sequelize) {
        await migrateDown(sequelize.getQueryInterface());
        const [rows] = await sequelize.query(`SELECT to_regclass('"ChargingAdmissionCallouts"') AS relation`);
        expect((rows[0] as { relation: string | null }).relation).toBeNull();
      }
    } finally { await sequelize?.close(); }
  });
  suite('postgres (SequelizeChargingCalloutStore)', async () => {
    await ChargingAdmissionCallout.destroy({ where: {} });
    return new SequelizeChargingCalloutStore({ config: {} as never, sequelizeInstance: sequelize });
  });
}
