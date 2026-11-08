# Upgrade CI trigger review — 2026-11-08

Base runtime source: `f55d067664b581dd4eb3db4b0246b984e9d20264`.
This branch changes workflows and CI fixtures only. It does not change runtime source,
configuration, images or deployed services. No hosted run or PR has been opened during source
preparation.

| Workflow                                                                          | Effective PR behavior after this change                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| test-build-server.yml                                                             | Canonical hosted Ubuntu 24.04 bounded backend install/build/runtime/typecheck lane; backend/workspace/script path filters. Replaces self-hosted Compose/Newman.                                                                                                                                                                                                                                              |
| unit-tests.yml                                                                    | Operator/workspace/guard path filters; calls coordinated-operator-build.yml. Removes duplicate backend and self-hosted full-stack jobs.                                                                                                                                                                                                                                                                      |
| coordinated-operator-build.yml                                                    | Reusable hosted bounded Operator lane plus manual dispatch; no independent push duplicate.                                                                                                                                                                                                                                                                                                                   |
| lint.yml                                                                          | Every PR; hosted Ubuntu 24.04, pinned Node/pnpm, guarded install and sequential workspace lint.                                                                                                                                                                                                                                                                                                              |
| license-check.yml                                                                 | Every PR; hosted Ubuntu 24.04, guarded REUSE install/check with existing ignore-file policy; unrecognized failing diagnostics fail.                                                                                                                                                                                                                                                                          |
| operator-e2e-manual.yml                                                           | No PR trigger. Manual hosted synthetic browser and optional simulated EVerest acceptance, exact job ownership and larger resource budget.                                                                                                                                                                                                                                                                    |
| component-version-policy.yml                                                      | Existing hosted source policy; PR execution restricted to same-repository heads. Unchanged.                                                                                                                                                                                                                                                                                                                  |
| check-dependency-catalog.yml                                                      | Existing hosted PR policy, conditional on repository citrineos/citrineos. Unchanged.                                                                                                                                                                                                                                                                                                                         |
| release-version-check.yml                                                         | Existing hosted PR policy, conditional on citrineos/citrineos and head next. Unchanged.                                                                                                                                                                                                                                                                                                                      |
| mock-msp.yml                                                                      | Existing hosted workflow, conditional on citrineos/citrineos. PR path/change selection can run build/lint/live Compose; label ci:mock-msp-everest or EVerest changes can select simulation. Unchanged; its separate upstream-only hosted stack is not covered by this guard and still pins its own older Node. Before enabling that workflow in another repository, review its live/Compose resource policy. |
| require-migration.yml                                                             | Existing hosted pull_request_target metadata check, citrineos/citrineos only. Unchanged.                                                                                                                                                                                                                                                                                                                     |
| close-ai-slop-prs.yml, greet-first-time-contributor.yml, label-conflicted-prs.yml | Hosted pull_request_target social/maintenance automation; now restricted to official citrineos/citrineos-core.                                                                                                                                                                                                                                                                                               |

There are no remaining self-hosted jobs triggered by pull_request or pull_request_target.
Self-hosted `push-release-tagged-{server,operator-ui,ocpi}.yml`, `publish-swagger.yml` and
`renew-certs.yml` remain outside PR triggers and this change. Their existing publish/deploy
behavior still needs separate review before a corresponding push/tag/scheduled event; this
change does not authorize or execute those events. Scheduled stale-review automation is restricted to official citrineos/citrineos-core.

The twelve Boot archive cases are required from actual runtime JSON. TypeScript input discovery
has separate labels. Operator HTTPS-forwarded acceptance exercises actual NextRequest through
an HTTP standalone process; the report explicitly excludes public TLS handshake proof.
See [guard commands and budgets](../../scripts/ci/README.md).

## Source review and local verification

Three review passes covered scope, implementation and surrounding behavior:

1. Scope: consolidated the duplicate backend lanes, moved all four former self-hosted PR
   surfaces to hosted execution, and retained full browser/simulator coverage as manual
   synthetic acceptance. Product packages, migrations and runtime configuration are unchanged.
2. Implementation: found and removed an overriding HTTP origin assignment in the new HTTPS
   forwarded-protocol fixture; retained smaller Docker limits and accounted for the existing
   EVerest manager's 4 GiB request in the manual profile. Native statuses remain distinct from
   guard failures and resource refusals.
3. Surrounding behavior: retained normal HTTP standalone tests, normal password/CSRF/session
   authentication, Operator unit regressions and its native TypeScript check; checked reusable
   workflow triggers, cleanup ownership and private-artifact exclusions. No guard weakening or
   product-source change was required.

Local small standard-library guard fixtures: **9 passed**, native exit 0, 2.23 seconds,
maximum owned process-group RSS 24.77 MiB, minimum available memory 7261.35 MiB, reserve
1536 MiB. The external bounded runner used heap 128 MiB / process RSS cap 640 MiB.
Evidence is `control/bounded-core-ci-guard-fixtures-a3.log` in the coordination root, outside
this source checkout. The tests use synthetic ownership/memory inputs and a fake Docker Unix
server; they do not claim actual Docker daemon or hosted application acceptance.

Python AST, Node syntax, Bash syntax, workflow YAML parsing, effective PR runner inventory,
changed Markdown/JavaScript/JSON/YAML Prettier checks and whitespace checks passed. Full
install/build/Vitest/TypeScript/lint/REUSE/standalone/browser/EVerest execution is deferred to
hosted CI after root reviews this concrete source diff. No deployment host, database, live
service, real IAM credential or SMS was accessed.

## Fork governance adaptation

All four vendor social/maintenance jobs now require the exact job-level condition
`github.repository == 'citrineos/citrineos-core'`. Existing triggers and vendor behavior are
preserved for that official repository; EVYAR forks skip the entire job, including manual
and scheduled invocations. The previous source already restricted these jobs to
`citrineos/citrineos`; it did not allow arbitrary forks. This change corrects the explicit
upstream identity rather than claiming an observed fork-side bot action.

| Workflow                          | Trigger                                                  | Write actions gated away from forks                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| close-ai-slop-prs.yml             | pull_request_target opened/edited/reopened               | Comments and closes a PR when one line includes the AI SLOP phrase and a robot emoji. Authorized fork PR markers remain subject to human governance, without this vendor closure bot.       |
| close-stale-changes-requested.yml | Daily 06:00 UTC and manual                               | Reviews non-draft changes-requested PRs; warns after 14 days without commits and closes after 28; no-autoclose label exempts.                                                               |
| label-conflicted-prs.yml          | Daily 07:00 UTC, manual, pull_request_target synchronize | Adds/removes conflict labels; warns after 14 days and closes after 21 days of labelled conflict; no-autoclose exempts warnings/closure. Synchronize only removes a resolved conflict label. |
| greet-first-time-contributor.yml  | pull_request_target opened                               | Posts a first-time contributor welcome comment with vendor contribution/governance links.                                                                                                   |

No release, migration/schema, catalog, license, lint or test job is disabled or regated by
this adaptation. These jobs have no checkout and their existing scripts use GitHub metadata
APIs; the gate precedes every write-capable step. No bot action was executed during review.
