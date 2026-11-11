---
type: Runbook
title: CI test determinism
description: "Run CI checks with isolated browser, database, and service fixtures."
---

# CI test determinism

The required test job builds Meitheal, installs the Chromium version pinned by Playwright, and runs each spec against a fresh loopback-only production server. Two lanes run independently, with one Playwright worker per server. Each server has its own temporary SQLite database and rate-limit counters. The server environment contains no Home Assistant or cloud credentials. Model-backed evaluations are outside the required suite.

The task runtime opens the shared libSQL client without loading the Drizzle adapter. Persistence specs that use `getDb()` load Drizzle on the first typed query. If a typed-query spec fails while HTTP routes stay healthy, verify the test installation includes `drizzle-orm` before investigating the database.

Use Node 22 and pnpm 10.34.9. The pnpm 10.x pin includes security fixes for dependency installation. [pnpm security advisories](https://github.com/pnpm/pnpm/security/advisories)

From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @meitheal/web build
pnpm --filter @meitheal/tests exec playwright install --only-shell chromium
(
  test_tmp=$(mktemp -d)
  trap 'rm -rf -- "$test_tmp"' EXIT
  TMPDIR="$test_tmp" pnpm --filter @meitheal/tests test:ci
)
```

The hosted Linux runner uses `playwright install --with-deps --only-shell chromium` to install system dependencies too. The full suite uses ports 4611 and 4612 by default. Use `MEITHEAL_TEST_PORT` to choose the start of a different unused pair. Playwright refuses to reuse an existing server. A healthy fixture serves `/api/health` and reports standalone mode.

To reproduce one browser spec, set `MEITHEAL_TEST_BROWSER=1` and pass its path to `pnpm --filter @meitheal/tests test`. For focused tests that need no server, omit that variable. Tests requiring a server skip in that local mode unless an external base URL is provided. Use external URLs only for a disposable instance because some specs create or delete data. The full CI runner always sets fixture mode.

License tests generate ephemeral Ed25519 keys in memory. The production verifier trusts only the embedded public key and rejects tokens signed by a test key. The tests never need a signing key from disk.

Agent-token CRUD tests pass a synthetic authenticated identity directly to the route handler and use their own SQLite file. The standalone HTTP test checks that anonymous requests are denied. Trusted identity propagation through HA ingress is a separate integration check.

The security header tests check that the deprecated browser XSS filter stays off and the script policy excludes `data:` URLs. [OWASP HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html#x-xss-protection).

Treat a failed assertion as a product or test-contract finding. Inspect the failing request and fixture state before changing the expectation. A CI fixture covers standalone behavior. Supervisor, ingress, and Home Assistant acceptance still use the project's dedicated verification environments.

Set `MEITHEAL_TEST_PORT` to an unused unprivileged port when running the disposable browser fixture alongside another local test run. The default is 4611.
