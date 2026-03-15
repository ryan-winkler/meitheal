# Persona Loop Index and Classification

This index normalizes existing persona-loop artifacts without deleting historical data.

## Classification Rules

1. `execution-linked`
- Artifacts are used to support phase completion claims in roadmap/state.

2. `exploratory`
- Insight artifacts that influence planning but do not gate phase completion by themselves.

3. `historical import`
- Non-standard or imported artifacts preserved for traceability.

## Folder/File Classification

| Path | Classification | Notes |
|------|----------------|-------|
| `50-persona-audit.md` | exploratory | Cross-domain audit reference used by later planning. |
| `phase-1/` | execution-linked | Canonical 7-file iterations with implementation logs for foundational work. |
| `phase-2/` | execution-linked | Canonical iteration template present; commit evidence linked to phase 02 summaries. |
| `phase-3/` | exploratory | Partial loop artifacts (`01` + `07`) only; informative, non-gating. |
| `phase-4/` | exploratory | Contextual frontier input only; no full execution loop. |
| `phase-5/` | exploratory | Mixed artifact style (`findings` files) without full template. |
| `phase-6/` | exploratory | Full loop files exist but mapped to phase-06 draft planning, not execution completion. |
| `phase-7/` | exploratory | Partial iteration artifact set. |
| `phase-8/` | exploratory | Audit/cycle artifacts from prior agent flow. |
| `phase-08.1/` | execution-linked | Canonical 7-file iteration for Settings UI/UX polish closeout and verification. |
| `phase-09/` | execution-linked | Canonical search-hub iteration covering universal search parity and HA search unification. |
| `phase-9/` | exploratory | Gap-analysis snapshots, not canonical execution loops. |
| `phase-10/` | historical import | Single cycle-decision snapshot from prior workflow variant. |
| `phase-11/` | historical import | Discussion-only imported artifact. |
| `phase-13-security/` | historical import | Imported security audit memo style. |
| `phase-14-extensibility/` | historical import | Imported audit memo style. |
| `phase-14-gap-analysis/` | historical import | Imported competitor-matrix snapshot. |
| `phase-15/` | execution-linked | Canonical 7-file iteration created for UX parity and board-domain execution planning. |
| `phase-17/` | execution-linked | Canonical 7-file iteration tied to full persona-audit execution setup and findings closure. |

## Cross-Links (Analysis Baseline)

1. `docs/analysis/gap-matrix.md`
2. `docs/analysis/parity-spec.md`
3. `docs/analysis/competitors/*.md`

## Normalization Notes

1. No files were moved or deleted in this pass.
2. Completion claims are based on phase summaries and commit/test evidence, not on exploratory persona artifacts alone.
3. Future iterations should use the canonical 7-file template from the GSD skill workflow.
