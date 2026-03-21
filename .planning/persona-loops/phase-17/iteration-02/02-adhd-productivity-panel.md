# ADHD/Productivity Panel - Phase 17 Iteration 02

## Objective
Pillars + Principles domain (expanded): service, API, North Star UX, AI integration, strategic evaluator, conflict resolution

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Workflow Coach | Build the AI onboarding wizard as a 3-question conversational flow, not a form. Questions: (1) "What do you protect at all costs?" (2) "What boundary did someone cross recently?" (3) "What would you fight to keep even if everything else changed?" AI drafts 3-5 Pillars with 1-2 Principles each. User edits, not creates from scratch. Success: empty state shows wizard, not blank grid. | 5 | 4 | 2 | Accept |
| Execution Coach | Conflict resolution warning must be a toast-style inline notification, NOT a modal dialog. ADHD users will rage-close modals without reading them. Toast appears with Pillar icon + "This overlaps with [Principle]. Reschedule?" with a dismiss action. Warning is logged but never blocks. Success: conflict warning renders as toast, not modal. | 5 | 2 | 1 | Accept |
| Knowledge Coach | Update AGENTS.md DDD Context Boundaries table, hierarchy-glossary (add Principle, Manifesto, Non-Negotiable), README feature list, and Memory knowledge graph with all new domain terms. All doc updates in same commit as corresponding code. Success: `grep -r "pillars" AGENTS.md README.md docs/kcs/hierarchy-glossary.md` returns matches. | 4 | 2 | 1 | Accept |
| Focus Optimizer | PillarCard on North Star page should use `manifesto` text as the hero element (large, readable) with icon+color as accent — not the Pillar name as hero. Identity framing means the WHY statement is what users see first: "I am someone who builds lasting health" → then name: "Vitality". Success: manifesto text is visually larger than Pillar name in PillarCard. | 4 | 2 | 1 | Accept |
| Automation Coach | Strategic evaluator boost must be transparent: show a small "Pillar boost: +2" tag next to the RICE/ICE score so users understand WHY a task ranked higher. Hidden boosting feels like broken sorting. Success: task list shows boost indicator when Pillar weight contributed to sort order. | 4 | 2 | 1 | Accept |

## Rejected or Deferred

- (none)
