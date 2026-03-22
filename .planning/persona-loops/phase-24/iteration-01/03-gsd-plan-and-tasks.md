# GSD Plan & Tasks — Phase 24, Iteration 01

**Objective:** Settings UI/UX, memory, click, and crash optimizations
**Date:** 2026-03-22

## Accepted Tasks

| # | Task | Source | Impact | Effort | Priority |
|---|------|--------|--------|--------|----------|
| T1 | Add `AbortSignal` to all settings `addEventListener` calls | Frontier: Platform Arch | 4 | 2 | P0 |
| T2 | Escape scope strings in AgentTokens `innerHTML` | Frontier: Security | 4 | 1 | P0 |
| T3 | Fix SettingsLabels re-render killing cursor on title edit | ADHD: Workflow Coach | 5 | 2 | P0 |
| T4 | Disable submit buttons during API calls in SettingsLabels | ADHD: Focus Optimizer | 4 | 1 | P0 |
| T5 | Parallelize bot settings save (3×PUT → Promise.all) | ADHD: Execution Coach | 3 | 1 | P1 |
| T6 | Add ingress path prefix to Labels/AgentTokens fetch calls | Frontier: Reliability | 3 | 1 | P1 |
| T7 | Add error states with retry to Labels/AgentTokens loading | Frontier: Product Arch | 3 | 2 | P1 |
| T8 | Add `autocomplete="off"` to token name input | Frontier: Security | 3 | 1 | P2 |
| T9 | Add scope tooltips/descriptions to AgentTokens | ADHD: Knowledge Coach | 3 | 2 | P2 |
| T10 | Replace test result auto-clear timer with persist-until-action | ADHD: Automation Coach | 3 | 1 | P2 |

## Execution Order

1. **T1** — Memory leak fix (all 3 components)
2. **T2** — XSS fix (AgentTokens)
3. **T3** — Cursor fix (Labels)
4. **T4** — Double-submit (Labels)
5. **T5** — Parallel save (Agents)
6. **T6** — Ingress prefix (Labels, AgentTokens)
7. **T7** — Error states (Labels, AgentTokens)
8. **T8-T10** — Polish (tokens, scopes, test results)

## GSD Commands

Execute via `/gsd-execute-phase 24` with tasks above as the plan.
