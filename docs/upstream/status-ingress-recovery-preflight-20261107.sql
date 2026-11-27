-- Read-only EXACT comparison only when BOTH legacy source and receipt ledger exist.
-- Choose a reviewed source table: OCPPMessages before swap, OCPPMessages_old
-- after swap. Never silently substitute a different table/schema or empty source.
-- Example below uses the pre-swap live heap. Review archive recovery separately.
BEGIN READ ONLY;
SELECT count(*) AS mismatched_existing_receipt_ids
FROM "OCPPMessages" m JOIN "StatusIngressReceipts" r ON r.id=m.id
WHERE m."statusIngressConnection" IS NOT NULL AND (
 r."tenantId" IS DISTINCT FROM m."tenantId" OR r."stationId" IS DISTINCT FROM m."stationId"
 OR r.connection IS DISTINCT FROM m."statusIngressConnection"
 OR r."correlationId" IS DISTINCT FROM m."correlationId" OR r.protocol IS DISTINCT FROM m.protocol
 OR r.frame IS DISTINCT FROM m.message OR r.timestamp IS DISTINCT FROM m.timestamp);
SELECT count(*) AS natural_keys_with_different_ids
FROM "OCPPMessages" m JOIN "StatusIngressReceipts" r
 ON r."tenantId"=m."tenantId" AND r."stationId"=m."stationId"
 AND r.connection=m."statusIngressConnection" AND r."correlationId"=m."correlationId"
WHERE m.id IS DISTINCT FROM r.id;
-- This coverage count may be positive BEFORE first bridge (rows still need copying);
-- AFTER bridge it must be zero before archive/backup deletion or activation.
SELECT count(*) AS bound_rows_without_receipt
FROM "OCPPMessages" m LEFT JOIN "StatusIngressReceipts" r ON r.id=m.id
WHERE m."statusIngressConnection" IS NOT NULL AND r.id IS NULL;
SELECT count(*) AS missing_or_misattributed_status_receipts
FROM "StatusNotifications" sn LEFT JOIN "StatusIngressReceipts" r ON r.id=sn."ingressMessageId"
WHERE sn."ingressMessageId" IS NOT NULL AND (r.id IS NULL
 OR sn."tenantId" IS DISTINCT FROM r."tenantId" OR sn."stationId" IS DISTINCT FROM r."stationId");
ROLLBACK;
