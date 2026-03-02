# ADR 0013: Dual-Licensing Strategy (AGPLv3 + Commercial)

## Status
Accepted — Supersedes the licensing posture in ADR 0001

## Date
2026-03-02

## Context

Meitheal needs a licensing strategy that achieves five goals simultaneously:

1. **Open Source eligibility** — Qualify for GitHub Sponsors, Open Collective, and OSS grants via an OSI-approved license.
2. **Acquisition readiness** — Maintain 100% IP ownership so the project is a clean, valuable asset for potential acquisition.
3. **HA ecosystem health** — Keep Home Assistant and Node-RED integrations frictionless (HA is Apache 2.0).
4. **Anti-freeloader protection** — Prevent companies from hosting Meitheal as a SaaS without contributing back.
5. **Plugin ecosystem growth** — Don't deter third-party developers from building integrations.

ADR 0001 established AGPL-3.0 as the root license and laid out the dual-track architecture (meitheal-core vs vikunja-adapter). This ADR formalizes the complete commercialization and IP strategy.

## Decision

### 1. Core: AGPLv3 (Dual-Licensed)

**Applies to:** `apps/`, `packages/`, `meitheal-hub/`

The AGPL-3.0 closes the "SaaS loophole" — any company hosting Meitheal over a network must open-source their full stack. This forces commercial users to acquire a paid license. The same codebase is available under a commercial license from the maintainer.

### 2. CLA (Contributor License Agreement)

**Applies to:** All pull requests.

A CLA bot (contributor-assistant GitHub Action) requires every contributor to sign the CLA before their PR can be merged. The CLA grants Ryan Winkler the broad commercial rights needed to dual-license. Contributors retain their copyright. Without the CLA, fractured copyright would block acquisition and commercial licensing.

### 3. Permissive Edges: Apache 2.0

**Applies to:** `integrations/home-assistant/`, `integrations/nodered/`

HA custom components and Node-RED flows are explicitly Apache 2.0. These components communicate with the AGPL core strictly over network APIs (REST/WebSocket), so the AGPL copyleft does not cross the boundary. This eliminates legal friction in the HA ecosystem.

### 4. API / Plugin Exception

**Stated in:** `LICENSE` header and `COMMERCIAL.md`

Interacting with Meitheal via its published REST, WebSocket, or MCP APIs does not create a derivative work. Third-party developers can build plugins under any license. This exception does not cover embedding Meitheal source code.

### 5. Vikunja Adapter Isolation

The `apps/web/src/domains/integrations/vikunja-compat/` module remains AGPL-only and is excluded from any commercial license grant. Vikunja is AGPL-3.0 and we don't own their copyright — therefore, we cannot relicense their code.

## Consequences

- The project qualifies for all major OSS funding platforms.
- A clean CLA trail makes the IP acquisition-ready from day one.
- HA ecosystem contributors face zero legal friction.
- SaaS operators must negotiate a commercial license — the primary monetization path.
- Plugin developers get an explicit green light via the API exception.
- The Vikunja adapter requires architectural decoupling to be maintained (already in place).
- A `COMMERCIAL.md` document provides clear guidance to businesses.
- ADR 0001's branding policy remains valid; only its licensing posture is superseded.
