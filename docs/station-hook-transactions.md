# Station lookup hooks retain their caller transaction

APP63 failed before charging while OCPP 1.6 automatically commissioned another
EVSE. Its actual Core error stack ended in `Evse.resolveStationId` calling
`ChargingStation.findOne` without the transaction held by `Evse.findOrCreate`.
With both bounded pool connections retained by concurrent managed operations,
that lookup attempted an unavailable additional checkout.

Fourteen station resolution hooks had this same omission. Each now accepts the
Sequelize create-hook options and passes only `options.transaction` to its
existing, tenant-and-station-scoped lookup. The two previously corrected hooks
(`Transaction` and `ChargingStationSequence`) retain their implementation. Existing
station IDs, default tenant logic, ordinary calls without hook options, model
hooks, pool limits and shutdown deadlines retain their behavior.

The regression covers all sixteen registered station resolution hooks. Actual
PostgreSQL cases execute the EVSE, connector, status and latest-status hooks under
two simultaneous managed transactions in a two-connection pool, with distinct
tenants sharing a station name. The fixture creates a dedicated task database
and station table; it never changes retained acceptance sessions or assets.
