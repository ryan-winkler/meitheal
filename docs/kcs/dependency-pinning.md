---
type: "Runbook"
title: "Dependency pinning and code scanning"
description: "Update hash-pinned build and test inputs and review code scanning alerts."
---

# Dependency pinning and code scanning

Meitheal hash-pins its JavaScript workspace, GitHub Actions, container toolchain, and Home Assistant test dependencies so builds can be reproduced from the same inputs. Home Assistant base images (`ghcr.io/home-assistant/{arch}-base`), Alpine `apk` packages, and Playwright browser downloads intentionally track their upstream release streams rather than static hashes. OpenSSF Scorecard checks pinning in its Pinned-Dependencies check, and GitHub code scanning shows its findings beside CodeQL and Codacy.

## What is pinned and where

| Input | Pin | Updated by |
|-------|-----|------------|
| GitHub Actions | Full commit SHA, with the release tag in a comment | Dependabot (`github-actions`) |
| App builder image | `node:<tag>@sha256:<digest>` in `meitheal-hub/Dockerfile` | Dependabot (`docker`) |
| pnpm in the App image and devcontainer | `meitheal-hub/toolchain/package-lock.json`, installed with `npm ci` | Dependabot (`npm`, `/meitheal-hub/toolchain`) |
| Workspace packages | `pnpm-lock.yaml`, installed with `--frozen-lockfile` | Dependabot (`npm`, `/`) |
| Home Assistant test environments | `integrations/home-assistant/requirements-test*.txt`, compiled with hashes from the matching `.in` file (Dependabot `pip` updates require regenerating the matching `.txt` via `uv pip compile --generate-hashes`) | Dependabot (`pip`) |

The Home Assistant base images (`ghcr.io/home-assistant/{arch}-base`) stay on their tag. Supervisor passes them through `build.json` per architecture, Dependabot cannot update digests there, and a digest that never moves would stop base-image security fixes from reaching the App.

## Changing a pinned dependency

- **pnpm version:** change `packageManager` in the root `package.json`, every `version:` under `pnpm/action-setup` in the workflows, `meitheal-hub/toolchain/package.json`, `.devcontainer/devcontainer.json`, and `tests/governance/ha-integration-contract.spec.ts`. Then run `npm install --package-lock-only --ignore-scripts` in `meitheal-hub/toolchain`.
- **Home Assistant test requirements:** edit the `.in` file, then regenerate the `.txt` file with the command in its header, for example:

  ```sh
  cd integrations/home-assistant
  uv pip compile --generate-hashes --python-version 3.14.2 --python-platform x86_64-manylinux_2_28 requirements-test.in -o requirements-test.txt
  ```

  Install it with `python -m pip install --require-hashes -r requirements-test.txt`.

## Reviewing code scanning alerts

Alerts come from three tools: CodeQL (default setup), Codacy (`codacy.yml`, converted to SARIF by `scripts/codacy-json-to-sarif.mjs`), and Scorecard (`scorecard.yml`).

1. Fix the finding in code when it is real.
2. When it does not apply, dismiss it in GitHub with the reason (false positive, used in tests, or won't fix) and one sentence that names the guard or design that makes it safe. Codacy fingerprints use the text of the flagged line, so a dismissal survives line moves and returns only if the line itself changes.
3. Do not change `scripts/green-canary-driver-parent.sh` or the Green workload scripts for lint findings. Their SHA-256 values are part of the Green benchmark receipts.

Repository settings drive some Scorecard checks, such as Branch-Protection and Code-Review. They change in the repository settings, not in code.
