# Hosted CI resource guard

The automatic backend lane is `.github/workflows/test-build-server.yml`. It installs the
frozen pnpm workspace, builds the OCPP and OCPI dependency closures sequentially, runs
Vitest projects base/dal/ocpp/ocpi in separate sequential processes with one worker and no file parallelism, then runs the
four native TypeScript test checks. `backend-report.py` reads actual Vitest JSON assertions;
TypeScript `--listFiles` results are labelled input discovery, never executed test cases.
The runtime report requires all twelve Boot archive integration assertions to pass.

`unit-tests.yml` calls the existing Operator standalone workflow. It retains Operator Vitest unit regressions and a native TypeScript check, builds once and tests
actual Next HTTP, password/CSRF/cookie/session and synthetic GraphQL/Core transport. The
second sequential server checks HTTPS forwarded-protocol handling against an exact internal
origin. HTTP transport with a proxy header is not a public TLS handshake or real database
CRUD acceptance.

Every guarded command refuses non-GitHub-hosted Linux execution. Workflows pin Ubuntu 24.04,
Node 24.22.2 and pnpm 10.19.0, use read-only repository permissions and do not inherit deployment
secrets. The child environment is allowlisted rather than copied from the runner.

## Budgets and evidence

`bounded.py` is a job-local standard-library wrapper, not a deployment runner. All profiles
keep 1536 MiB available. Preflight requires the complete child/container budget plus that
reserve. The monitor uses the smaller of host MemAvailable and finite cgroup remaining
memory, measures the owned process group's RSS, and measures new containers through Docker
stats (anonymous RSS, RSS, or conservative usage fallback). Missing statistics fail closed.

| Profile   | Node heap MiB | Process RSS MiB | Container RSS sum MiB | Timeout seconds |
| --------- | ------------: | --------------: | --------------------: | --------------: |
| install   |          1536 |            2304 |                     0 |             900 |
| build     |          1536 |            2304 |                     0 |            1200 |
| runtime   |          1536 |            3072 |                  1024 |            1800 |
| typecheck |          1536 |            2304 |                     0 |             900 |
| lint      |          1536 |            2304 |                     0 |            1200 |
| stdlib    |           128 |             640 |                     0 |             300 |
| operator  |          4096 |            4608 |                     0 |            1500 |
| e2e       |          1536 |            2304 |                  7168 |            3600 |

Docker-capable jobs use an ephemeral Unix socket proxy. Before forwarding a container-create
request it adds the job's random ownership label and enforces memory/swap, CPU and PID limits.
The normal runtime cap is 512 MiB per container; manual E2E uses 4096 MiB (the existing EVerest manager requests 4 GiB). Smaller requested
limits survive. These are actual Docker HostConfig limits, verified again against live
containers, rather than a claim that Docker belongs to the Node process group. Docker build
and daemon memory remain covered by the host/cgroup reserve monitor, not the child RSS metric.

Pre-existing containers are recorded before commands start. Cleanup removes only containers
absent from that baseline and carrying this job's exact label. Unexpected unlabelled new
containers fail the job and are not adopted or removed. There is no global prune, host-wide
kill or Docker restart. Child process groups and proxy sockets are closed on failure as well
as success; workflow cleanup also runs with `always()`. Runtime containers are cleaned before
the following TypeScript stages. Native status is retained separately from guard status;
resource refusal/termination is not a successful test run. Stage names cannot be retried over
existing evidence. JSON receipts pin the checkout commit; logs and receipts are mode 0600.

## Optional full browser/simulator lane

`operator-e2e-manual.yml` preserves full Operator browser and optional EVerest simulation
coverage as hosted **manual** acceptance. It uses current root Compose files, a synthetic
loopback JWT issuer and generated disposable credentials; it does not read deployment
credentials or contact real IAM. It has no Newman or obsolete `Server/` paths. Its larger
budget must pass preflight or the lane refuses; there is no shared-host fallback. The
standalone PR lane remains the automatic UI acceptance lane.

Manual fixtures and Compose overrides end in `.private.json` and are excluded from uploaded
artifacts. Only result/guard evidence and browser reports are uploaded. A manual fixture PASS
means synthetic hosted full-stack acceptance, not real IAM/dev/production acceptance.

Source preparation has not executed application install/build/tests or this manual lane.
Hosted execution after source review must establish compatibility of the real Docker clients,
images and application tests. Small guard fixtures cover real Unix proxy create requests
(content-length and chunked), budgets/ownership, native exit propagation and environment
sanitization without Docker or application services.

The first hosted combined runtime process hit RSS 2326.20 MiB against 2304 MiB, with host
minimum available 12901 MiB. Parent approved runtime RSS 3072 MiB only; the Node heap 1536,
Docker RSS 1024 and fixed reserve 1536 remain unchanged. The derived runtime config explicitly
disables typechecking on inline projects: Vitest 3.2.7 does not propagate that CLI override.
It preserves the normal monorepo aliases, test selection and timeouts. Each project now has
its own guard receipt and actual runtime JSON; the combined report sums only those actual
assertions. Native TSC still runs separately after successful builds even if runtime tests
fail, and a runtime failure remains a failing workflow.

Manual backend dispatch may set `ocpp_fixture_focus=true` to run the nine reviewed OCPP
fixture files only. PR/default dispatch remains the complete four-project runtime lane.
The focused receipt is labelled OCPP_NINE_FIXTURE_FILES_NOT_FULL_BACKEND_ACCEPTANCE and keeps
native TypeScript checks separate. Its in-memory receipt fixture models serialized ownership,
identity and rollback only; projection application fails without an explicit database fixture.
It does not replace or claim PostgreSQL atomicity/integration acceptance.

The DAL diagnostic-only integration records safe invariant codes, current guard phase,
container identity and HTTP status when an invariant fails. It does not retain raw daemon
response bodies or change thresholds, ownership, failure behavior or cleanup. The historical
unclassified guard failure's cause remains unknown. A classified empty-stats socket fixture
shows one possible lifecycle race; it does not prove that historical cause. The separate
hosted DAL diagnostic run 42469015168 completed 1085 runtime assertions including all twelve
Boot archive cases, with zero typed-discovery entries; this is DAL-only evidence, not full
backend acceptance.

## Fresh container evidence after unavailable statistics

A running inspect snapshot followed by unavailable stats now triggers exactly one fresh inspect
of that same already-owned container ID. Zero RSS is accepted only when the fresh inspect
still proves the exact ID and job ownership label, requires Memory and MemorySwap to equal
the original inspected values exactly (a smaller valid cap also fails), and reports Running=false,
Status=exited, no paused/restarting/dead state, and a valid nonzero timezone-aware FinishedAt.
A missing/deleted inspect, changed owner/ID/limits, still-running state, or incomplete stop
state fails closed. There is no last-known RSS substitution, grace timer or stats retry.
An OOM flag still fails the stage, and an independent native process failure retains its exit.
All profiles, reserve, aggregate accounting and owned cleanup rules are unchanged.

Each recheck writes a bounded allowlist of ID, ownership label and State fields to a mode-0600
`*-container-stats.private.jsonl` file. Environment variables, arbitrary labels, daemon error
bodies and health logs are never copied. The Core repository is public, so these snapshots
remain runner-private and are excluded from the normal uploaded backend artifact. Public
receipts retain recheck/verified-stopped counts and fixed decision-enum counts: `missing-inspect`,
`inspect-unavailable`, `identity-or-ownership-mismatch`, `limits-changed`, `still-running`,
`incomplete-stop` and `verified-exited`. This summary contains no IDs, ownership nonces,
timestamps, environment values or raw errors. Runner-private snapshots are ephemeral
unless root separately arranges private collection. This change does not provide a private
external artifact sink or claim that a previous missing-stats failure was a stopped-container race.

Standard-library fixtures use real temporary Unix HTTP sockets and tiny owned child processes,
not Docker or application services. They distinguish stop-between-inspect/stats from still-running
empty stats, missing fresh inspect, changed ID/ownership/limits, incomplete/restarting state,
OOM and nonzero native exits. They do not establish DAL/OCPP acceptance. A new full hosted run
requires root's review of this follow-up diff.
