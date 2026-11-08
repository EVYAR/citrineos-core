# Historical migration provenance

`provenance.json` is the sole canonical declaration of archive provenance. Schema version 1
has `schemaVersion`, `baselineCommit` and `entries`; each entry has root-relative
`archivedPath`, `originalCommit`, `originalPath`, lowercase body `sha256` and `reason`.
Every archive has exactly one entry and every original migration path is unique. Source
commits must be ancestors of the frozen baseline
`af5f736f16e2c7390255b2e49d66769e41a7863f`. The manifest owns declarative provenance;
consumers must not maintain a second list or a legacy alias resolver.

The three previously archived bodies remain unchanged and use that baseline as their
source commit. `20260921090000-add-live-meter-read-indexes.ts.txt` instead preserves
`apps/ocpp-server/migrations/20260921090000-add-live-meter-read-indexes.ts` from
`a72c8dc262f02cb4063fffa5c4e91d6699dbb9ba`. Commit
`3d8c4902b493bad8c6f7f2c3ffb8eb8c58877c76` reverted that source less than two minutes
later, so it is absent at the frozen baseline.

The parent reports that the isolated restored actual development history contains 60
rows, including the three previously known retired migrations, seven OCPI migrations
and `20260921090000-add-live-meter-read-indexes.js`. Its read-only inspection verified
both `transactions_tenant_station_transaction_id_idx`
(`tenantId`, `ocppConnectionName`, `transactionId`, `id DESC`) and
`meter_values_tenant_transaction_timestamp_idx`
(`tenantId`, `transactionDatabaseId`, `timestamp`, `id`). Those observations are supplied
context, not database checks executed in this source-only task.

These archives are evidence only. Do not reactivate prepartition DDL, alter applied
migrations, or insert, remove or normalize SequelizeMeta rows. The fixture proof retains
actual before/after arrays and recorded spellings; spelling classification only selects
existing rows. Application wiring and normal CLI discovery are unchanged.

Unique new runtime behavior: none. New migration/ledger mutations: none. New legacy alias
resolvers: none. Source/provenance rejection checks in `migrationProof` cover malformed
paths/basenames, duplicate entries, mismatched file sets, symlinked manifests/archives
and directory traversal, invalid digests,
non-ancestor source commits and archive/source byte divergence. Body mismatch diagnostics
contain filenames and hashes only, never raw source buffers. No tests, installs,
builds, services or remote calls were run for this change; parent verification is pending.
