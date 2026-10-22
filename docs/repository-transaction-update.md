# Transaction preservation for per-row repository updates

`SequelizeLocationRepository.createOrUpdateConnector` opens a managed transaction
and supplies it to `updateAllByQuery`. The base repository previously used that
transaction for `findAll`, then omitted it from each row's update and reload.
Two concurrent connector status updates could retain both bounded-pool checkouts
while each waited for an additional checkout. An update could also persist even
when its enclosing transaction rolled back.

The fix passes only the caller's transaction through to the existing instance
update/reload methods. Instance hooks, tenant filtering, ordinary calls without a
transaction, pool limits and shutdown deadlines retain their existing behavior.

An isolated PostgreSQL fixture with a two-connection pool reproduces acquisition
timeout and escaped rollback before the change. The same fixture passes after the
change, including concurrent updates, rollback, foreign-tenant exclusion and
ordinary no-transaction/empty-result calls. It creates its own connector-shaped
model/table and never mutates acceptance or production connector records.

APP61 shutdown diagnostics independently showed two exact Core-owned connections
idle in transaction, both retaining the same SELECT hash. Those diagnostics prove
the pool-drain boundary; they do not identify the SELECT relation or prove this is
the only live path responsible. A fresh end-to-end run must confirm normal drain.
