---
description: "Use when working on Meitheal planning, roadmap, requirements, persona loops, KCS docs, or phase-scoped implementation. Covers GSD artifact precedence, documentation updates, and memory usage to reduce context drift."
applyTo: ".planning/**/*.md, docs/**/*.md, .github/prompts/**/*.md"
---

# Meitheal Planning And Documentation

- Treat `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md` as the current source of truth when they exist.
- For non-trivial scoped work already represented in `.planning/`, follow the GSD sequence: discuss, plan, execute, verify.
- When phase files exist, respect them in order: `*-CONTEXT.md`, `*-RESEARCH.md`, `*-PLAN.md`, `*-SUMMARY.md`, `*-VERIFICATION.md`.
- Keep KCS and planning artifacts current in the same change set as behavior changes. Do not update code and leave roadmap or state stale.
- For design-heavy, UX-heavy, or architecture-heavy work, consult the relevant persona-loop outputs before closing the task.
- Use repo memory for short, verified facts that will help future sessions avoid context drift. Do not store secrets or guesses.
