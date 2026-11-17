---
type: Decision
title: Temporary build-only Picomatch audit exception
description: "Bound the unpatched Picomatch advisory exception to CI build dependencies through November 23, 2026."
---

# ADR 0023 — Temporary build-only Picomatch audit exception

Date 2026-11-17

Status Accepted until 2026-11-24 00:00 UTC

## Context

GHSA-fc5q-39xc-vjpf affects Picomatch through 4.0.7 when attacker-supplied extglob patterns cause excessive regular-expression backtracking. The reviewed advisory lists no patched release. The published latest version is 4.0.7. [GitHub advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)

The current lockfile includes Picomatch through Astro and its development tools. The recursive production dependency graph contains no Picomatch. Application source has no direct Picomatch import, and the generated server contains no Picomatch module reference. The App image installs production dependencies separately from its builder. Its build inputs are reviewed repository files.

## Decision

Accept this build-time denial-of-service risk until November 24, 2026. CI may exclude only GHSA-fc5q-39xc-vjpf when its recursive production dependency lookup succeeds, returns a JSON array, and contains no Picomatch paths. A failed lookup or malformed result fails the step. A production dependency or the expiry date restores the complete audit.

The exception is written into the disposable CI checkout and followed by an actual `pnpm audit`. The `--ignore` command alone saves the advisory ID without performing the audit. All other advisories and registry errors retain their normal exit status. [pnpm audit](https://pnpm.io/cli/audit)

## Follow-through

The upstream vulnerability and Dependabot alert remain open. The release operator checks the exact packaged runtime for Picomatch before publication. When a patched release becomes available, update the lockfile, remove the temporary workflow branch and run the complete audit. The exception expires automatically and requires a new decision to extend.
