# Operator standalone session and transport acceptance

The isolated Operator validator previously loaded a compiled route without starting Next. It now copies static
and public assets into its temporary standalone artifact and starts that artifact with a 256 MiB Node heap.
Only random loopback ports and generated synthetic credentials participate; shared runtime configuration and
application source behavior are unchanged.

`node scripts/validate-operator-isolated.mjs 4096` builds the synthetic profile and runs the companion
`scripts/validate-operator-standalone.mjs`. The hosted coordinated Operator workflow runs this command and
uploads `operator-build-validation.json` with its source SHA and companion content hash after success.

The actual Next server handles CSRF acquisition, invalid CSRF rejection, wrong-password denial, credentials
callback, session cookie issuance and session retrieval. Unauthenticated GraphQL may be denied by middleware
with a login redirect; the validator accepts only that redirect or 401 and proves neither reaches the fixture.
Unauthenticated Core REST must return 401.

Logged-in GraphQL requests exercise create/read/update/delete payload forwarding and response transport through
`/api/graphql`. Synthetic upstream receipts require the server-only Hasura credential, tenant 7 and role user;
browser cookie/Authorization headers must not propagate. Requests with any x-hasura override, cross-origin,
cross-site or missing write origin are rejected before upstream contact. Oversized requests are also rejected.
Upstream errors, non-success status, reflected secret, oversized body, redirect and a stalled response must
produce a small sanitized 502, with the application deadline bounded by the client's 15-second deadline.

The actual Next Core route and shared machine-token provider also run. A wrong-audience signed synthetic token
must fail before Core fixture contact. A valid synthetic ES256 token is verified by a loopback fixture before
returning a permissions response; tenant override and cross-origin requests are rejected. This is not the
actual Core JWT auth server: its signature/JWKS/permission acceptance remains separately required.

Both build-time and runtime secret canaries are checked against HTTP bodies/headers, login HTML and all textual
public/static artifacts. A static JS chunk is fetched from the actual standalone server as well. This is HTTP
and bundle inspection, not browser automation. Synthetic CRUD payloads never contact a database or real Hasura;
reports explicitly set realDatabaseCrud, realHasuraAuthorization and actualCoreServerJwtAcceptance to false.

Each request has a deadline, startup readiness is bounded and a two-minute watchdog kills only the directly
owned standalone child. Finally cleanup aborts owned requests, destroys tracked fixture sockets, closes the
owned loopback servers and terminates/reaps that child (TERM, then bounded KILL). It never searches for or kills
other processes. The caller removes only its uniquely created artifact directory after companion cleanup.

Source-only preparation: no install, build, test, server launch or remote action was performed locally. Parent
review and hosted execution remain required; no passing runtime result is claimed by this source change.

Three source review passes covered the requested session/transport behavior, bounded resource ownership and
surrounding build/report compatibility. The lifecycle pass added signal cleanup and streaming client body
limits; the fixture pass kept redirects on loopback and required an upstream receipt for each failure probe.
The final surrounding review found no additional issue. Prettier formatted only the changed files and
`git diff --check` passed; hosted build/runtime acceptance remains unrun by instruction.
