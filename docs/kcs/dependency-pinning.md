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
| Home Assistant test environments | `integrations/home-assistant/requirements-test*.txt`, compiled with hashes from the matching `.in` file and `overrides-2026.10.txt` for Core `2026.10.4` (Dependabot `pip` updates require regenerating the matching `.txt` via `uv pip compile --generate-hashes`, passing `--overrides overrides-2026.10.txt` for `requirements-test-2026.10.txt`) | Dependabot (`pip`) |

The Home Assistant base images (`ghcr.io/home-assistant/{arch}-base`) stay on their tag. Supervisor passes them through `build.json` per architecture, Dependabot cannot update digests there, and a digest that never moves would stop base-image security fixes from reaching the App.

## Changing a pinned dependency

- **pnpm version:** change `packageManager` in the root `package.json`, every `version:` under `pnpm/action-setup` in the workflows, `meitheal-hub/toolchain/package.json`, `.devcontainer/devcontainer.json`, and `tests/governance/ha-integration-contract.spec.ts`. Then run `npm install --package-lock-only --ignore-scripts` in `meitheal-hub/toolchain`.
- **Home Assistant test requirements:** edit the `.in` file (and `integrations/home-assistant/overrides-2026.10.txt` if changing an overridden pin such as `pillow` on Core `2026.10.4`), then regenerate the `.txt` lockfile with the command in its header:

  ```sh
  cd integrations/home-assistant
  uv pip compile --generate-hashes --python-version 3.14.2 --python-platform x86_64-manylinux_2_28 requirements-test.in -o requirements-test.txt
  uv pip compile --generate-hashes --python-version 3.14.2 --python-platform x86_64-manylinux_2_28 --overrides overrides-2026.10.txt requirements-test-2026.10.in -o requirements-test-2026.10.txt
  ```

  Create an isolated virtual environment and install either lockfile (`requirements-test.txt` or `requirements-test-2026.10.txt`) with Rust-based `uv` (installed in CI via SHA-pinned `astral-sh/setup-uv` `0.13.6`):

  ```sh
  uv venv --python 3.14 .venv
  VIRTUAL_ENV="$PWD/.venv" uv pip install --require-hashes --no-deps -r <file>
  VIRTUAL_ENV="$PWD/.venv" uv pip check -q
  ```

  Passing `--no-deps` is required for `requirements-test-2026.10.txt` because `overrides-2026.10.txt` pins `pillow` above `homeassistant==2026.10.4`'s `Pillow==12.3.0` wheel metadata; `uv pip check -q` reports that single intentional mismatch (`Found 1 incompatibility` / ``The package `homeassistant` requires `pillow==12.3.0`, but `13.0.0` is installed``) on `2026.10.4` and exits `0` on `2026.11.1`. Because Dependabot (`pip`) runs without `overrides-2026.10.txt` and opens no override PRs against `2026.10.4`, bump `overrides-2026.10.txt` manually upon `pillow` security alerts (or alongside `requirements-test.txt` Core updates) and recompile `requirements-test-2026.10.txt` with `--overrides overrides-2026.10.txt`. Likewise, whenever an unrelated weekly Dependabot `pip` PR touches `integrations/home-assistant`, check whether Dependabot failed resolution or reverted `pillow` to `12.3.0` in `requirements-test-2026.10.txt` and recompile with `--overrides overrides-2026.10.txt` before merging.

## Reviewing code scanning alerts

Alerts come from three tools: CodeQL (default setup), Codacy (`codacy.yml`, converted to SARIF by `scripts/codacy-json-to-sarif.mjs`), and Scorecard (`scorecard.yml`).

1. Fix the finding in code when it is real.
2. When it does not apply, dismiss it in GitHub with the reason (false positive, used in tests, or won't fix) and one sentence that names the guard or design that makes it safe. Codacy fingerprints use the text of the flagged line, so a dismissal survives line moves and returns only if the line itself changes.
3. Do not change `scripts/green-canary-driver-parent.sh` or the Green workload scripts for lint findings. Their SHA-256 values are part of the Green benchmark receipts.

Repository settings drive some Scorecard checks, such as Branch-Protection and Code-Review. They change in the repository settings, not in code.
