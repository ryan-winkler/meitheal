---
type: "Reference"
title: "ADR Template and Guidelines"
description: "Template and do's and don'ts for writing durable Architecture Decision Records."
---

# ADR Template and Guidelines

Use an Architecture Decision Record (ADR) in `docs/decisions/` to capture durable architectural, domain-boundary, security, licensing, schema, or time-bounded policy decisions that future contributors need to understand.

## Do's

- Use numbered filenames (`NNNN-short-kebab-title.md`), include OKF YAML frontmatter (`type: "Decision"`, `title`, `description`), and add an index bullet to [the ADR index](index.md).
- State technical context, the chosen decision, alternatives weighed, and concrete consequences in plain English.
- Reference concrete repository paths, schemas, standards, or measured benchmarks.
- Supersede an accepted ADR with a new numbered ADR rather than silently rewriting historical decisions.
- Follow the [documentation bundle rules](../knowledge-bundle.md) and run `pnpm --filter @meitheal/tests test governance/docs-okf.spec.ts` before opening a pull request.

## Don'ts

- Do **not** commit non-ADR decision logs, individual AI agent runs, raw persona scorecards, review receipts, audit logs, or working scratch/progress notes anywhere inside `docs/` or tracked Git paths. Keep them git-excluded under `.planning/`.
- Do **not** substitute internal runner phase numbers, iteration counts, or synthetic agent vote tallies for technical rationale.
- Do **not** leave unindexed `.md` files under `docs/decisions/` (the repository governance suite treats every `.md` file in `docs/` as part of the indexed bundle).

## Template

Copy the skeleton below to `docs/decisions/NNNN-short-kebab-title.md` and register it in `docs/decisions/index.md`:

````markdown
---
type: "Decision"
title: "ADR NNNN: Short Decision Title"
description: "One-line summary of the architectural or policy decision."
---

# ADR NNNN: Short Decision Title

- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Superseded by ADR NNNN
- **Deciders:** Maintainer names or roles

## Context

State the technical, product, security, or operational problem forcing a decision and any binding constraints.

## Decision

Describe the chosen approach, affected domain boundaries or schemas, and invariants that code and tests must uphold.

## Alternatives Considered

- **Option A:** Summary and why it was not chosen.
- **Option B:** Summary and why it was not chosen.

## Consequences

- **Positive:** Concrete gains or simplified maintenance.
- **Negative / Risks:** Trade-offs, migration needs, or follow-up work.

## Related

- Relevant code paths, KCS runbooks, or superseded ADRs
````
