# Dokploy Core environment handoff

The duplicate Core Compose deployment translated obsolete bootstrap names and defaulted runtime startup to
`migrate`. It now requires `CORE_ENV_FILE` containing the complete schema-backed application environment and
sets runtime `DB_STRATEGY=none`. Offline migration and partition provisioning remain prerequisites.

A complete file carries settings beyond database/broker/cache connections, including authentication, role seed,
listener asset, CA integration and charging callouts. The health check reads the configured container HTTP port.
The app README explains path resolution, secret-file placement and deployment-reference resolution.

Three source review passes covered requested behavior, solution choice and surrounding deployment behavior.
The solution pass found the fixed healthcheck port and changed it to use the container setting. The surrounding
review retained build arguments, image path, expose list and health intervals. No other source issue was found.

No build, install, test, lint, format command or runtime deployment check was run: this work was explicitly
source-only. Parent owns execution and must validate the rendered environment privately, run required checks,
and exercise authentication, listener TLS and integration round trips before deployment.
