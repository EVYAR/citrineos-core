// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

/** New evidence only: no retained native row or original decision is rewritten. */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`
-- Lock once during migration so no station can be inserted between backfill
-- and trigger installation. This is independent mutable fence metadata.
LOCK TABLE "ChargingStations" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "ChargingAdmissionStationGuards" (
  "stationId" integer PRIMARY KEY REFERENCES "ChargingStations" ("id") ON DELETE CASCADE,
  "revision" bigint NOT NULL DEFAULT 0 CHECK ("revision" >= 0)
);
CREATE FUNCTION charging_admission_seed_station_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  INSERT INTO "ChargingAdmissionStationGuards" ("stationId") VALUES (NEW."id");
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_seed_station_guard AFTER INSERT ON "ChargingStations"
  FOR EACH ROW EXECUTE FUNCTION charging_admission_seed_station_guard();
INSERT INTO "ChargingAdmissionStationGuards" ("stationId") SELECT "id" FROM "ChargingStations";

CREATE TABLE "ChargingAdmissionWithdrawals" (
  "id" uuid PRIMARY KEY,
  "tenantId" integer NOT NULL REFERENCES "Tenants" ("id") ON DELETE RESTRICT,
  "chargingCalloutRef" uuid NOT NULL UNIQUE REFERENCES "ChargingAdmissionCallouts" ("id") ON DELETE RESTRICT,
  "idempotencyKey" varchar(255) NOT NULL CHECK (length("idempotencyKey") > 0),
  "requestHash" char(64) NOT NULL CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  "actorSubject" text NOT NULL CHECK (length("actorSubject") > 0),
  "stationId" integer NOT NULL REFERENCES "ChargingStations" ("id") ON DELETE RESTRICT,
  "authorizedConnectorId" integer NOT NULL REFERENCES "Connectors" ("id") ON DELETE RESTRICT,
  "commercialConnectorId" integer NOT NULL REFERENCES "Connectors" ("id") ON DELETE RESTRICT,
  "fence" bigserial NOT NULL UNIQUE CHECK ("fence" > 0),
  "withdrawnAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "receipt" jsonb NOT NULL,
  UNIQUE ("tenantId", "idempotencyKey"),
  CHECK ("authorizedConnectorId" <> "commercialConnectorId")
);
CREATE INDEX "ChargingAdmissionWithdrawals_authorized_idx"
  ON "ChargingAdmissionWithdrawals" ("tenantId", "authorizedConnectorId", "withdrawnAt");
CREATE INDEX "ChargingAdmissionWithdrawals_commercial_idx"
  ON "ChargingAdmissionWithdrawals" ("tenantId", "commercialConnectorId", "withdrawnAt");
CREATE TABLE "ChargingAdmissionConsumptions" (
  "tenantId" integer NOT NULL REFERENCES "Tenants" ("id") ON DELETE RESTRICT,
  "stationId" integer NOT NULL REFERENCES "ChargingStations" ("id") ON DELETE RESTRICT,
  "connectorId" integer NOT NULL REFERENCES "Connectors" ("id") ON DELETE RESTRICT,
  "authorizationId" integer NOT NULL REFERENCES "Authorizations" ("id") ON DELETE RESTRICT,
  "chargingCalloutRef" uuid NOT NULL UNIQUE REFERENCES "ChargingAdmissionCallouts" ("id") ON DELETE RESTRICT,
  "nativeRequestId" text NOT NULL CHECK (length("nativeRequestId") BETWEEN 1 AND 255),
  "nativeRequestHash" char(64) NOT NULL CHECK ("nativeRequestHash" ~ '^[0-9a-f]{64}$'),
  "transactionDatabaseId" integer NOT NULL,
  "transactionCreatedAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "snapshot" jsonb NOT NULL,
  PRIMARY KEY ("transactionDatabaseId", "transactionCreatedAt"),
  FOREIGN KEY ("transactionDatabaseId", "transactionCreatedAt")
    REFERENCES "Transactions" ("id", "createdAt") ON DELETE RESTRICT,
  UNIQUE ("tenantId", "stationId", "nativeRequestId")
);

CREATE FUNCTION charging_admission_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'Charging admission evidence is append-only' USING ERRCODE = '23514';
END $fn$;
CREATE TRIGGER charging_admission_withdrawal_immutable BEFORE UPDATE OR DELETE
  ON "ChargingAdmissionWithdrawals" FOR EACH ROW EXECUTE FUNCTION charging_admission_immutable();
CREATE TRIGGER charging_admission_consumption_immutable BEFORE UPDATE OR DELETE
  ON "ChargingAdmissionConsumptions" FOR EACH ROW EXECUTE FUNCTION charging_admission_immutable();

CREATE FUNCTION charging_admission_callout_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "chargingCalloutRef" = OLD."id")
    OR EXISTS (SELECT 1 FROM "ChargingAdmissionConsumptions" WHERE "chargingCalloutRef" = OLD."id") THEN
    RAISE EXCEPTION 'Consumed or withdrawn charging admission callout is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_callout_immutable BEFORE UPDATE OR DELETE
  ON "ChargingAdmissionCallouts" FOR EACH ROW EXECUTE FUNCTION charging_admission_callout_immutable();

CREATE FUNCTION charging_admission_withdrawal_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE c "ChargingAdmissionCallouts"%ROWTYPE; locked_count integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Charging admission fencing requires READ COMMITTED' USING ERRCODE = '23514';
  END IF;
  -- This exact connector-ascending/callout-last order is shared with the owner service.
  PERFORM "id" FROM "Connectors"
    WHERE "id" IN (NEW."authorizedConnectorId", NEW."commercialConnectorId")
      AND "tenantId" = NEW."tenantId" AND "stationId" = NEW."stationId"
    ORDER BY "id" FOR UPDATE;
  GET DIAGNOSTICS locked_count = ROW_COUNT;
  IF locked_count <> 2 THEN
    RAISE EXCEPTION 'Withdrawal connector mapping diverged' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM "ChargingAdmissionCallouts" WHERE "id" = NEW."chargingCalloutRef" FOR UPDATE;
  IF NOT FOUND OR c."tenantId" <> NEW."tenantId" OR c."connectorId" <> NEW."authorizedConnectorId"
    OR c."state" <> 'AUTHORIZED' OR c."decidedAt" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "Authorizations" a WHERE a."id" = c."authorizationId" AND a."tenantId" = NEW."tenantId")
    OR NOT EXISTS (SELECT 1 FROM "ChargingStations" s WHERE s."id" = NEW."stationId"
      AND s."tenantId" = NEW."tenantId" AND s."ocppConnectionName" = c."ocppConnectionName")
    OR EXISTS (SELECT 1 FROM "ChargingAdmissionConsumptions" WHERE "chargingCalloutRef" = c."id") THEN
    RAISE EXCEPTION 'Withdrawal grant identity/state diverged or grant already consumed' USING ERRCODE = '23514';
  END IF;
  -- Advance a real row version, not a lock-only sentinel: a REPEATABLE READ
  -- or SERIALIZABLE writer with a pre-withdrawal snapshot must get PostgreSQL's
  -- serialization failure when it subsequently locks this station guard.
  UPDATE "ChargingAdmissionStationGuards" SET "revision" = "revision" + 1
    WHERE "stationId" = NEW."stationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal station guard is missing' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "Transactions" t WHERE t."tenantId" = NEW."tenantId"
    AND t."stationId" = NEW."stationId" AND t."isActive"
    AND (t."connectorId" IN (NEW."authorizedConnectorId", NEW."commercialConnectorId") OR t."connectorId" IS NULL)) THEN
    RAISE EXCEPTION 'Withdrawal conflicts with an active or unassigned transaction' USING ERRCODE = '23514';
  END IF;
  IF NEW."withdrawnAt" < date_trunc('milliseconds', transaction_timestamp())
    OR NEW."withdrawnAt" > clock_timestamp()
    OR NEW."receipt"->>'schemaVersion' IS DISTINCT FROM 'CORE_AUTHORIZED_TARGET_WITHDRAWAL_V1'
    OR NEW."receipt"->>'coreEvidenceRef' IS DISTINCT FROM 'core-withdrawal:' || NEW."id"::text
    OR NEW."receipt"->>'chargingCalloutRef' IS DISTINCT FROM c."id"::text
    OR NEW."receipt"->>'coreTenantId' IS DISTINCT FROM NEW."tenantId"::text
    OR NEW."receipt"->>'ocppConnectionName' IS DISTINCT FROM c."ocppConnectionName"
    OR NEW."receipt"->>'authorizationId' IS DISTINCT FROM c."authorizationId"::text
    OR NEW."receipt"->>'originalDecision' IS DISTINCT FROM 'AUTHORIZED'
    OR (NEW."receipt"->>'originalDecisionRecordedAt')::timestamptz IS DISTINCT FROM c."decidedAt"
    OR NEW."receipt"#>>'{authorizedTarget,nativeConnectorId}' IS DISTINCT FROM NEW."authorizedConnectorId"::text
    OR NEW."receipt"#>>'{requestedCommercialTarget,nativeConnectorId}' IS DISTINCT FROM NEW."commercialConnectorId"::text
    OR NEW."receipt"#>>'{withdrawal,state}' IS DISTINCT FROM 'WITHDRAWN'
    OR NEW."receipt"#>>'{withdrawal,durable}' IS DISTINCT FROM 'true'
    OR NEW."receipt"#>>'{withdrawal,fence}' IS DISTINCT FROM NEW."fence"::text
    OR (NEW."receipt"#>>'{withdrawal,withdrawnAt}')::timestamptz IS DISTINCT FROM NEW."withdrawnAt"
    OR NEW."receipt"->>'requestHash' IS DISTINCT FROM NEW."requestHash"::text
    OR NEW."receipt"->>'actorSubject' IS DISTINCT FROM NEW."actorSubject" THEN
    RAISE EXCEPTION 'Withdrawal receipt diverged' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_withdrawal_insert BEFORE INSERT ON "ChargingAdmissionWithdrawals"
  FOR EACH ROW EXECUTE FUNCTION charging_admission_withdrawal_insert();

CREATE FUNCTION charging_admission_consumption_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE c "ChargingAdmissionCallouts"%ROWTYPE; t "Transactions"%ROWTYPE;
  latest_withdrawal timestamptz; provenance jsonb; station_connection text;
BEGIN
  PERFORM "id" FROM "Connectors" WHERE "id" = NEW."connectorId"
    AND "tenantId" = NEW."tenantId" AND "stationId" = NEW."stationId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consumption connector mapping diverged' USING ERRCODE = '23514';
  END IF;
  PERFORM "stationId" FROM "ChargingAdmissionStationGuards"
    WHERE "stationId" = NEW."stationId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consumption station guard is missing' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM "ChargingAdmissionCallouts" WHERE "id" = NEW."chargingCalloutRef" FOR UPDATE;
  SELECT "ocppConnectionName" INTO station_connection FROM "ChargingStations"
    WHERE "id" = NEW."stationId" AND "tenantId" = NEW."tenantId";
  IF c."id" IS NULL OR c."tenantId" <> NEW."tenantId" OR c."connectorId" <> NEW."connectorId"
    OR c."authorizationId" <> NEW."authorizationId" OR c."state" <> 'AUTHORIZED'
    OR c."decidedAt" IS NULL OR c."ocppConnectionName" IS DISTINCT FROM station_connection
    OR NOT EXISTS (SELECT 1 FROM "Authorizations" a WHERE a."id" = NEW."authorizationId" AND a."tenantId" = NEW."tenantId")
    OR EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "chargingCalloutRef" = c."id") THEN
    RAISE EXCEPTION 'Charging admission consumption grant diverged or withdrawn' USING ERRCODE = '23514';
  END IF;
  SELECT max("withdrawnAt") INTO latest_withdrawal FROM "ChargingAdmissionWithdrawals"
    WHERE "tenantId" = NEW."tenantId" AND ("authorizedConnectorId" = NEW."connectorId" OR "commercialConnectorId" = NEW."connectorId");
  IF latest_withdrawal IS NOT NULL AND c."requestedAt" <= latest_withdrawal THEN
    RAISE EXCEPTION 'Charging admission intent predates connector withdrawal' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO t FROM "Transactions" WHERE "id" = NEW."transactionDatabaseId" AND "createdAt" = NEW."transactionCreatedAt";
  IF t."id" IS NULL OR t."tenantId" <> NEW."tenantId" OR t."stationId" IS DISTINCT FROM NEW."stationId"
    OR t."connectorId" IS DISTINCT FROM NEW."connectorId" OR t."authorizationId" IS DISTINCT FROM NEW."authorizationId"
    OR NOT EXISTS (SELECT 1 FROM "Transactions" WHERE "id" = t."id" AND "createdAt" = t."createdAt"
      AND xmin = pg_current_xact_id()::xid)
    OR NOT EXISTS (SELECT 1 FROM "TransactionKeys" k WHERE k."transactionDatabaseId" = t."id"
      AND k."createdAt" = t."createdAt" AND k."stationId" = NEW."stationId"
      AND k."tenantId" = NEW."tenantId" AND k.xmin = pg_current_xact_id()::xid)
    OR EXISTS (SELECT 1 FROM "StartTransactions" WHERE "transactionDatabaseId" = t."id" AND "transactionCreatedAt" = t."createdAt")
    OR EXISTS (SELECT 1 FROM "TransactionEvents" WHERE "transactionDatabaseId" = t."id" AND "transactionCreatedAt" = t."createdAt" AND "eventType" = 'Started') THEN
    RAISE EXCEPTION 'Consumption must precede the first Start in the native write transaction' USING ERRCODE = '23514';
  END IF;
  provenance := NEW."snapshot";
  IF jsonb_typeof(provenance) IS DISTINCT FROM 'object'
    OR provenance->>'schemaVersion' IS DISTINCT FROM '1.0.0'
    OR provenance->>'chargingCalloutRef' IS DISTINCT FROM NEW."chargingCalloutRef"::text
    OR provenance->>'nativeRequestId' IS DISTINCT FROM NEW."nativeRequestId"
    OR provenance->>'nativeRequestHash' IS DISTINCT FROM NEW."nativeRequestHash"::text
    OR (SELECT count(*) FROM jsonb_object_keys(provenance)) <> 4
    OR jsonb_typeof(provenance->'nativeRequestId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'nativeRequestHash') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Invalid charging admission provenance' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := clock_timestamp();
  NEW."snapshot" := provenance || jsonb_build_object(
    'databaseTransactionId', pg_current_xact_id()::text,
    'tenantId', NEW."tenantId", 'stationId', NEW."stationId", 'connectorId', NEW."connectorId",
    'authorizationId', NEW."authorizationId", 'requestedAt', c."requestedAt", 'decidedAt', c."decidedAt");
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_consumption_insert BEFORE INSERT ON "ChargingAdmissionConsumptions"
  FOR EACH ROW EXECUTE FUNCTION charging_admission_consumption_insert();

CREATE FUNCTION charging_admission_consume(
  tenant integer, station integer, connector integer, authorization integer,
  "transactionDatabaseId" integer, "transactionCreatedAt" timestamptz, provenance jsonb
) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF provenance IS NULL THEN
    PERFORM "id" FROM "Connectors" WHERE "tenantId" = tenant AND "stationId" = station
      AND (connector IS NULL OR "id" = connector) ORDER BY "id" FOR UPDATE;
    PERFORM "stationId" FROM "ChargingAdmissionStationGuards" WHERE "stationId" = station FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Consumption station guard is missing' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "tenantId" = tenant AND "stationId" = station
      AND (connector IS NULL OR "authorizedConnectorId" = connector OR "commercialConnectorId" = connector)) THEN
      RAISE EXCEPTION 'Protected connector requires charging admission provenance' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  INSERT INTO "ChargingAdmissionConsumptions" (
    "tenantId", "stationId", "connectorId", "authorizationId", "chargingCalloutRef",
    "nativeRequestId", "nativeRequestHash", "transactionDatabaseId", "transactionCreatedAt", "snapshot"
  ) VALUES (tenant, station, connector, authorization, (provenance->>'chargingCalloutRef')::uuid,
    provenance->>'nativeRequestId', provenance->>'nativeRequestHash', "transactionDatabaseId", "transactionCreatedAt", provenance);
END $fn$;

-- Lock native creation before the owner performs its complete-history read. The Start
-- trigger alone would leave an in-flight Transaction invisible to that read.
CREATE FUNCTION charging_admission_transaction_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(OLD."tenantId", OLD."stationId", OLD."connectorId", OLD."authorizationId")
      IS DISTINCT FROM ROW(NEW."tenantId", NEW."stationId", NEW."connectorId", NEW."authorizationId")
    AND (EXISTS (SELECT 1 FROM "ChargingAdmissionConsumptions" WHERE "transactionDatabaseId" = OLD."id" AND "transactionCreatedAt" = OLD."createdAt")
      OR EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "tenantId" = OLD."tenantId"
        AND ("authorizedConnectorId" = OLD."connectorId" OR "commercialConnectorId" = OLD."connectorId"))) THEN
    RAISE EXCEPTION 'Native started transaction identity is immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM "id" FROM "Connectors" WHERE "tenantId" = NEW."tenantId" AND "stationId" = NEW."stationId"
    AND (NEW."connectorId" IS NULL OR "id" = NEW."connectorId") ORDER BY "id" FOR UPDATE;
  IF NEW."stationId" IS NOT NULL THEN
    PERFORM "stationId" FROM "ChargingAdmissionStationGuards"
      WHERE "stationId" = NEW."stationId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Native transaction station guard is missing' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_transaction_lock BEFORE INSERT OR UPDATE OF "tenantId", "stationId", "connectorId", "authorizationId", "isActive"
  ON "Transactions" FOR EACH ROW EXECUTE FUNCTION charging_admission_transaction_lock();

CREATE FUNCTION charging_admission_start_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE t "Transactions"%ROWTYPE; consumption "ChargingAdmissionConsumptions"%ROWTYPE;
  c "ChargingAdmissionCallouts"%ROWTYPE; protected boolean; latest_withdrawal timestamptz;
BEGIN
  IF TG_ARGV[0] = 'event' THEN
    IF NEW."eventType" <> 'Started' THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO t FROM "Transactions" WHERE "id" = NEW."transactionDatabaseId" AND "createdAt" = NEW."transactionCreatedAt";
  IF t."id" IS NULL OR t."tenantId" <> NEW."tenantId" THEN
    RAISE EXCEPTION 'Start has no matching native transaction' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ChargingStations" s WHERE s."id" = t."stationId"
    AND s."tenantId" = t."tenantId" AND s."ocppConnectionName" = NEW."ocppConnectionName") THEN
    RAISE EXCEPTION 'Start station diverged from native transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_ARGV[0] = 'start' THEN
    IF NEW."connectorDatabaseId" IS DISTINCT FROM t."connectorId" THEN
      RAISE EXCEPTION 'Start connector diverged from native transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM "id" FROM "Connectors" WHERE "tenantId" = t."tenantId" AND "stationId" = t."stationId"
    AND (t."connectorId" IS NULL OR "id" = t."connectorId") ORDER BY "id" FOR UPDATE;
  PERFORM "stationId" FROM "ChargingAdmissionStationGuards"
    WHERE "stationId" = t."stationId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Start station guard is missing' USING ERRCODE = '23514';
  END IF;
  SELECT max("withdrawnAt") INTO latest_withdrawal FROM "ChargingAdmissionWithdrawals"
    WHERE "tenantId" = t."tenantId" AND "stationId" = t."stationId"
      AND (t."connectorId" IS NULL OR "authorizedConnectorId" = t."connectorId" OR "commercialConnectorId" = t."connectorId");
  protected := latest_withdrawal IS NOT NULL;
  SELECT * INTO consumption FROM "ChargingAdmissionConsumptions"
    WHERE "transactionDatabaseId" = t."id" AND "transactionCreatedAt" = t."createdAt";
  IF consumption."chargingCalloutRef" IS NULL THEN
    IF protected THEN RAISE EXCEPTION 'Protected connector Start requires fresh same-transaction consumption' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM "ChargingAdmissionCallouts" WHERE "id" = consumption."chargingCalloutRef" FOR UPDATE;
  IF consumption."tenantId" <> t."tenantId" OR consumption."stationId" IS DISTINCT FROM t."stationId"
    OR consumption."connectorId" IS DISTINCT FROM t."connectorId" OR consumption."authorizationId" IS DISTINCT FROM t."authorizationId"
    OR consumption."snapshot"->>'databaseTransactionId' IS DISTINCT FROM pg_current_xact_id()::text
    OR c."state" <> 'AUTHORIZED' OR c."connectorId" IS DISTINCT FROM t."connectorId" OR c."authorizationId" IS DISTINCT FROM t."authorizationId"
    OR c."tenantId" <> t."tenantId" OR c."ocppConnectionName" IS DISTINCT FROM NEW."ocppConnectionName"
    OR EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "chargingCalloutRef" = c."id")
    OR (protected AND c."requestedAt" <= latest_withdrawal)
    OR EXISTS (SELECT 1 FROM "StartTransactions" WHERE "transactionDatabaseId" = t."id" AND "transactionCreatedAt" = t."createdAt")
    OR EXISTS (SELECT 1 FROM "TransactionEvents" WHERE "transactionDatabaseId" = t."id" AND "transactionCreatedAt" = t."createdAt" AND "eventType" = 'Started') THEN
    RAISE EXCEPTION 'Start consumption diverged, expired, replayed or withdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_start_fence BEFORE INSERT ON "StartTransactions"
  FOR EACH ROW EXECUTE FUNCTION charging_admission_start_fence('start');
CREATE TRIGGER charging_admission_started_fence BEFORE INSERT ON "TransactionEvents"
  FOR EACH ROW EXECUTE FUNCTION charging_admission_start_fence('event');

-- Mapping updates already hold their own row lock. Freeze identity only when
-- evidence refers to it; status/telemetry and unrelated connector mappings remain mutable.
CREATE FUNCTION charging_admission_mapping_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'Connectors' THEN
    IF ROW(OLD."tenantId", OLD."stationId", OLD."evseId", OLD."connectorId", OLD."evseTypeConnectorId")
      IS DISTINCT FROM ROW(NEW."tenantId", NEW."stationId", NEW."evseId", NEW."connectorId", NEW."evseTypeConnectorId")
      AND (EXISTS (SELECT 1 FROM "ChargingAdmissionCallouts" WHERE "connectorId" = OLD."id")
        OR EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "authorizedConnectorId" = OLD."id" OR "commercialConnectorId" = OLD."id")) THEN
      RAISE EXCEPTION 'Charging admission connector mapping is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(OLD."tenantId", OLD."ocppConnectionName", OLD."protocol") IS DISTINCT FROM ROW(NEW."tenantId", NEW."ocppConnectionName", NEW."protocol")
      AND (EXISTS (SELECT 1 FROM "ChargingAdmissionCallouts" WHERE "tenantId" = OLD."tenantId" AND "ocppConnectionName" = OLD."ocppConnectionName")
        OR EXISTS (SELECT 1 FROM "ChargingAdmissionWithdrawals" WHERE "stationId" = OLD."id")) THEN
      RAISE EXCEPTION 'Charging admission station mapping is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER charging_admission_connector_mapping BEFORE UPDATE OF "tenantId", "stationId", "evseId", "connectorId", "evseTypeConnectorId"
  ON "Connectors" FOR EACH ROW EXECUTE FUNCTION charging_admission_mapping_fence();
CREATE TRIGGER charging_admission_station_mapping BEFORE UPDATE OF "tenantId", "ocppConnectionName", "protocol"
  ON "ChargingStations" FOR EACH ROW EXECUTE FUNCTION charging_admission_mapping_fence();
`, { transaction });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`
DROP TRIGGER charging_admission_station_mapping ON "ChargingStations";
DROP TRIGGER charging_admission_seed_station_guard ON "ChargingStations";
DROP TRIGGER charging_admission_connector_mapping ON "Connectors";
DROP TRIGGER charging_admission_started_fence ON "TransactionEvents";
DROP TRIGGER charging_admission_start_fence ON "StartTransactions";
DROP TRIGGER charging_admission_transaction_lock ON "Transactions";
DROP TRIGGER charging_admission_callout_immutable ON "ChargingAdmissionCallouts";
DROP TABLE "ChargingAdmissionConsumptions";
DROP TABLE "ChargingAdmissionWithdrawals";
DROP TABLE "ChargingAdmissionStationGuards";
DROP FUNCTION charging_admission_seed_station_guard();
DROP FUNCTION charging_admission_mapping_fence();
DROP FUNCTION charging_admission_start_fence();
DROP FUNCTION charging_admission_transaction_lock();
DROP FUNCTION charging_admission_consume(integer, integer, integer, integer, integer, timestamptz, jsonb);
DROP FUNCTION charging_admission_consumption_insert();
DROP FUNCTION charging_admission_withdrawal_insert();
DROP FUNCTION charging_admission_callout_immutable();
DROP FUNCTION charging_admission_immutable();
`, { transaction });
  });
}
