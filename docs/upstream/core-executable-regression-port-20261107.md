# Core regression gaps source handoff

Branch: `test/core-v21-regression-gaps-20261107`; starting commit: `e3d8ec432`.

Prepared only. No test execution or passing-suite claim. No runtime edits, schema edits, dependency changes, services, database, live API, station or SMS activity. Runtime fixes remain parent-owned. Unique none declaration: no additional unique archived regression sources beyond the four audited files are claimed covered by this change.

| New file                                                          | Existing Vitest project | Prepared expanded cases |
| ----------------------------------------------------------------- | ----------------------- | ----------------------: |
| `packages/ocpp/test/server/citrineos-server.shutdown.test.ts`     | `ocpp`                  |                       1 |
| `packages/ocpp/test/server/hasura-final-cost-permissions.test.ts` | `ocpp`                  |                       5 |
| `packages/base/test/config/charging-callout-tenant-map.test.ts`   | `base`                  |                      12 |
| `packages/base/test/config/real-time-admission-budget.test.ts`    | `base`                  |                       9 |
| Total                                                             |                         |                      27 |

Counts expand `it.each` rows by static inspection; they are not collected or passed test counts. No archived `.txt` file is included in Vitest discovery, and this is not a statement that all archived regression coverage has been restored. Existing project include globs discover the four new `.test.ts` files; no new project or alias wiring is needed.

## Audit and adaptations

All four inputs are under `docs/upstream/regression-sources/` at their original paths supplied in the task.

- Shutdown: ported the actual server prototype invocation to `packages/ocpp/src/server/citrineos-server.ts`, with the current nested `timeouts.shutdownGracePeriodSeconds`. Records HTTP, network, router, module, authorizer, channels, RabbitMQ and database order, then checks zero outstanding timers before cleanup. Current authorizer shutdown precedes RabbitMQ close; the archive placed it afterward. Retained only the important receiver-before-broker invariant using the current complete order. Restores process exit code and fake timers. No existing server test exercised this shutdown sequence/deadline assertion.
- Hasura: reads canonical on-disk metadata, not archived YAML. Retains narrow update columns, old/resulting row tenant fences, tenant-fenced select and absence of general-user updates or service-role inserts/deletes. Adapts Transactions selection to v2.1 `stationId` and partition key `createdAt`; rejects the obsolete direct `ocppConnectionName`. Adds tenant-fenced station relationship selection and absence of station writes for the role. This verifies metadata shape only, not applied Hasura enforcement or adapter compatibility.
- Tenant map: current `configSchema` in `packages/types/src/config/types.ts` replaces the old separate input/resolved schemas. One shared schema is tested once; no duplicated input/resolved counts. Preserves non-RFC-version platform GUID and ordinary UUID, rejects seven malformed references, preserves distinct explicit mappings, retains empty-map behavior and disabled default. Existing decline-receipt tests exercise mapped/unmapped behavior, not GUID schema validation.
- Admission budget: tests the current single config schema, preserving 8000 ms default, both 100/10000 ms boundaries, rejecting 99/10001 plus fractional/string/null shapes. Uses the relocated `timeouts` object for the independent 15-second decision cache. Existing authorizer tests supply a 100 ms timeout but do not assert these schema defaults/bounds/shapes.

No demonstrated runtime source bug found in the audited requirements by static inspection. Shutdown rejection/timeout behavior is outside the archived successful-cleanup case and is not claimed covered. The older direct transaction connection-name selection is an archive/API-shape mismatch already documented in `docs/csms-final-cost-hasura-role.md`, not something to restore.

## Static verification and review

Only TypeScript syntax parsing, formatting and whitespace/diff inspection were performed. No imports or application modules were executed by the syntax check. No build, install, test, typecheck, lint, container, database, service or API command was run.

Review passes: scope/provenance (four source ports, no runtime edits); solution (current schema names/timeout nesting/metadata paths and shape, no duplicate legacy-schema counts); surrounding behavior (fake timer/exit-code restoration and existing Vitest project discovery). A proposed source alias was removed after inspection found overlapping internal package aliases; no alias change is shipped.

## Deferred commands for the parent

Run only when the parent allocates the shared 16 GiB memory slot with its 1536 reserve. These commands are prepared, not executed here. Existing `@citrineos/types` package resolution uses built artifacts, as current tests do: build current sources first so stale dist cannot masquerade as source coverage.

```sh
pnpm build
pnpm exec vitest run --project base packages/base/test/config/charging-callout-tenant-map.test.ts packages/base/test/config/real-time-admission-budget.test.ts
pnpm exec vitest run --project ocpp packages/ocpp/test/server/citrineos-server.shutdown.test.ts packages/ocpp/test/server/hasura-final-cost-permissions.test.ts
pnpm typecheck:test
pnpm test
pnpm lint
pnpm exec prettier --check packages/base/test/config/charging-callout-tenant-map.test.ts packages/base/test/config/real-time-admission-budget.test.ts packages/ocpp/test/server/citrineos-server.shutdown.test.ts packages/ocpp/test/server/hasura-final-cost-permissions.test.ts control/CORE_REGRESSION_GAPS_RESULT.md
```

Full suite testcontainers prerequisites and any stack/round-trip verification remain parent-owned; none were started here. No PR or push is authorized by this handoff.
