# Durable status ingress order

This is an additive source design, not runtime acceptance. It addresses concurrent
Finishing and Available frames carrying the same valid OCPP timestamp. No status
value has precedence over another, and clocks are never advanced to create order.

## Authority and persistence

Reuse the existing `OCPPMessages` immutable original CALL row and its database
sequence; do not introduce a parallel receipt table. Add nullable
`statusIngressConnection` to that row, containing a UUID generated for the actual
socket (not the configured websocket server id). A partial unique key on
`tenantId, ocppConnectionName, statusIngressConnection, correlationId` binds a
StatusNotification original CALL. A replay with exactly equal protocol/action/
payload returns its original row; divergent reuse fails. Its id is the durable
status sequence. Store `ingressMessageId` as a foreign key on the historical
`StatusNotifications` row, with a unique nonnull index. No applied historical
migration is edited.

The network layer captures the socket generation in its message closure and in
its claimed cache connection entry. A status frame must match that exact current
generation; an old socket cannot adopt the generation of a new cached socket.
The bounded queue registers the frame synchronously in `onMessage`, before the
first cache/permission await. It serializes only status ingress through durable
CALL persistence and internal publish acknowledgement; other RPC responses and
other stations remain independent. Queue overflow and persistence failure reject
without publishing an unbound status. Queue size is at most 64 per station.

Move the status CALL persistence before internal sender fanout. The webhook
receives that same persisted row instead of creating a second receipt afterwards.
Propagate only its original id and socket generation in the internal message
context; consumer verifies tenant, station, protocol, original correlation id,
state/origin and complete payload equality against the actual persisted row.
Do not trust a caller-supplied ordinal alone.

## Atomic projection

Status service resolves topology as now, then invokes one repository operation
that locks the tenant-scoped station row. Inside that transaction validate the
original receipt, write immutable historical status once, and update both
Connector and LatestStatusNotification together. Compare actual charger
observation time first; an older observation cannot regress state. For equal
observation times, only a larger original receipt id can advance state. A replay
is a no-op. A bound state cannot be replaced by a legacy unbound event. History
can retain a valid older observation, but it cannot alter either live projection.
Delete all matching old latest pointers and create exactly one under the same
station lock. Do not swallow atomic projection errors. Apply the same path to
OCPP 1.6, 2.x and configured connector-0 broadcast without widening topology.

Reconnect does not reset the database sequence. Delayed frames from the retired
socket fail ingress; delayed internal messages retain their immutable old receipt
and lose the projection comparison against a newer connection's accepted receipt.
A same connection UUID cannot be generated from a millisecond timestamp.

## Required regressions before merge

- Equal-time Finishing then Available receives durable ids in socket order while
  persistence completion is deliberately blocked; another station still runs.
- Consume Available before Finishing: both history rows remain, but connector and
  single latest pointer retain Available with its newer receipt id.
- Replay identical CALL id returns original receipt and creates no history row;
  divergent payload on that same socket/id fails before fanout.
- New socket reusing an OCPP CALL id gets its own receipt, while the old socket
  generation cannot submit after reconnect. Older charger timestamps still lose.
- Transaction failure between connector and pointer writes rolls back both;
  concurrent projection workers leave exactly one latest pointer.
- Legacy nullable rows remain readable but cannot override an established bound
  projection. No arbitrary semantic ranking or sleep appears in any test.

The source now implements receipt reuse, captured socket generation, pre-fanout
persistence and atomic connector/latest/AvailabilityState projection. Registration
rechecks the actual current cache claim under the same station row lock used for
its generation write; that cache read has a two-second deadline. Broadcast keeps
one original connector-0 observation plus derived observations for actual
commissioned targets. Its unique history key is original receipt + connector +
COALESCE(EVSE,-1). Targets compare independently, so a legitimate newer individual
status can win against an older broadcast while other targets advance atomically.
The original body is validated before deriving these targets.

All tests authored in this change are initially UNRUN. The mocked transaction
contract tests establish intended query/transaction wiring, not real PostgreSQL
lock or rollback proof. Normal affected builds, existing status/router/network
regressions and a fresh canonical-migration PostgreSQL race fixture are required
before merge or runtime acceptance. The original c10 packet remains FAILED.

Focused source suite (execute only in the parent-granted serialized guard window):

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism \
  packages/core/src/modules/OcppRouter/test/module/status-ingress-queue.test.ts \
  packages/core/src/dal/test/layers/sequelize/repository/status-ingress-order.test.ts \
  packages/core/src/dal/test/layers/sequelize/repository/status-ingress-transaction.test.ts \
  packages/core/src/dal/test/layers/sequelize/repository/status-ingress-receipt.test.ts
```

Use this repository's own frozen dependencies and reviewed Node24 binary; never
borrow dependencies or mark the normal build successful from this documentation.

