---
type: "Decision"
title: "ADR-014: Eisenhower Matrix as First-Class Schema Columns"
description: "Records how task urgency and importance are represented in SQLite."
---

# ADR-014: Eisenhower Matrix as First-Class Schema Columns

**Date:** 2026-03-19
**Status:** Accepted
**Deciders:** Ryan Winkler

## Context

Meitheal's Eisenhower Matrix view previously derived quadrants heuristically from existing `priority` and `due_date` fields. This approach had several problems:

1. **Orphaned data** — urgency/importance weren't stored, so the quadrant couldn't be queried via MCP/A2A or displayed consistently across views
2. **Drag-and-drop was broken** — the selector bug (`querySelector("[data-id]")` instead of `dataset.id`) prevented task movement between quadrants
3. **No manual override** — users couldn't pin tasks to specific quadrants; every page reload re-derived the placement

## Decision

Add `urgency`, `importance`, and `eisenhower_override` as first-class columns on the `tasks` table:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `urgency` | INTEGER NOT NULL | 0 | Eisenhower x-axis (0-5, 0=unclassified) |
| `importance` | INTEGER NOT NULL | 0 | Eisenhower y-axis (0-5, 0=unclassified) |
| `eisenhower_override` | INTEGER NOT NULL | 0 | 1 = manually placed via drag |

Quadrant derivation uses threshold of 3: `urgency ≥ 3 AND importance ≥ 3` → Q1 (Do First), etc.

### Why not reuse `priority`?

- `priority` (1-5) is a single-axis ranking — it maps to "how important is this relative to other tasks"
- Eisenhower is a 2-axis decision matrix — urgency and importance are orthogonal dimensions
- Keeping them separate lets users set priority=1 (urgent) on a task that's actually not-urgent-but-important (Q2: Schedule)

## Consequences

- **Schema version bumped** to 7 — existing tasks get urgency/importance backfilled from priority + due_date
- **MCP and LLM API updated** — urgency/importance are top-level fields on all task CRUD tools
- **Drag-and-drop fixed** — dragging updates urgency/importance and sets `eisenhower_override=1`
- **"Eliminate" renamed to "Not Now"** — gentler framing for ADHD users (based on persona audit: "Wall of Awful" concept)
- **Framework YAML** (`eisenhower.yaml`) makes this a discoverable strategic lens alongside RICE, ICE, etc.

## Alternatives Considered

1. **Custom fields JSON blob** — More flexible but not queryable, not indexable, not type-safe
2. **Derived-only (no schema columns)** — Current approach, rejected because data is ephemeral and not shared across views/APIs
3. **Single `quadrant` column** — Would prevent granular urgency/importance scoring and future slider UI
