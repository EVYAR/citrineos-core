-- Read-only preflight for the DEPLOYED frozen fork BEFORE partitioning.
-- Run against a restored snapshot first, then with every writer stopped at cutover.
-- Schema probe must confirm all referenced legacy columns exist; if absent, STOP
-- and review OCPPMessages_old/backups. Do not substitute an empty source.
BEGIN READ ONLY;
SELECT table_name,column_name,data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name IN
 ('ChargingStations','OCPPMessages','OCPPMessages_old','StatusNotifications','StatusIngressReceipts')
AND column_name IN ('id','tenantId','stationId','statusIngressConnection','ingressMessageId','message','connection','frame')
ORDER BY table_name,column_name;
-- Every count below must be zero. No private frame/credential values are printed.
SELECT count(*) AS invalid_bound_source_rows FROM "OCPPMessages" m
LEFT JOIN "ChargingStations" s ON s.id=m."stationId" AND s."tenantId"=m."tenantId"
WHERE m."statusIngressConnection" IS NOT NULL AND (
 s.id IS NULL OR m."correlationId" IS NULL OR m.protocol IS NULL OR m.timestamp IS NULL
 OR m.message IS NULL OR jsonb_typeof(m.message) IS DISTINCT FROM 'array'
 OR m.message->>0 IS DISTINCT FROM '2' OR m.message->>1 IS DISTINCT FROM m."correlationId"
 OR m.message->>2 IS DISTINCT FROM 'StatusNotification' OR m.origin IS DISTINCT FROM 'cs'
 OR m.action IS DISTINCT FROM 'StatusNotification' OR m.state::text IS DISTINCT FROM '1');
SELECT count(*) AS duplicate_bound_identities FROM (
 SELECT 1 FROM "OCPPMessages" WHERE "statusIngressConnection" IS NOT NULL
 GROUP BY "tenantId","stationId","statusIngressConnection","correlationId" HAVING count(*)>1
) collisions;
SELECT count(*) AS missing_or_misattributed_status_witnesses FROM "StatusNotifications" sn
LEFT JOIN "OCPPMessages" m ON m.id=sn."ingressMessageId"
WHERE sn."ingressMessageId" IS NOT NULL AND (m.id IS NULL OR m."statusIngressConnection" IS NULL
 OR m."tenantId" IS DISTINCT FROM sn."tenantId" OR m."stationId" IS DISTINCT FROM sn."stationId");
ROLLBACK;
-- If StatusIngressReceipts already exists (recovery/rerun), separately compare its
-- id/natural key/tenant/station/protocol/frame/timestamp EXACTLY with the above source.
-- The bridge repeats these validations, aborts on mismatch, and checks status FKs.
-- A clean upstream install has no legacy ingress columns: inspect schema/history,
-- confirm no fork ordering history exists, and use the empty-ledger bridge path.
