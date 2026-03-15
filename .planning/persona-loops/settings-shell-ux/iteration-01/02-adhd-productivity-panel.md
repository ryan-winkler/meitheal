# ADHD & Productivity Panel - Settings Shell UX Iteration 01

## Objective
Reduce cognitive friction in Settings so people can recover context quickly, scan safely, and switch between sections without wondering whether the UI is broken.

## Recommendations

| Persona Lens | Recommendation | Impact | Effort | Risk | Decision |
|---|---|---:|---:|---:|---|
| Time-blind user | Make the fastest route to a section visually obvious | 5 | 1 | 1 | Accept |
| Low-energy user | Let top-level cards behave exactly like they look | 5 | 1 | 1 | Accept |
| Interruption-recovery user | Keep active state visible after scroll and deep-link jumps | 4 | 2 | 1 | Accept |
| Working-memory lens | Use one section model across strip, rail, and search | 5 | 2 | 1 | Accept |
| Scan-first user | Put icon + label + live status in the same predictable places | 4 | 2 | 1 | Accept |
| Anxiety-sensitive user | Remove dead-looking controls that undermine trust | 5 | 1 | 1 | Accept |
| Novice user | Make “Open” explicit so the strip reads as a navigation aid | 4 | 1 | 1 | Accept |
| Keyboard power user | Prefer anchor navigation over JS-only button behavior | 4 | 1 | 1 | Accept |
| Context-switching user | Clear search filtering when jumping to a new section | 5 | 1 | 1 | Accept |
| Mobile quick-adjust user | Keep identical jump semantics across desktop and mobile patterns | 4 | 2 | 1 | Accept |
| Screen-fatigue lens | Use strong active contrast without adding visual noise | 3 | 2 | 1 | Accept |
| Mistake-recovery user | Let hash/back-forward navigation restore context correctly | 4 | 2 | 2 | Accept |
| Habit-forming lens | Keep navigation targets stable so the page becomes learnable | 4 | 1 | 1 | Accept |
| Motivation-preserving lens | Replace “did nothing happen?” moments with crisp interaction feedback | 5 | 1 | 1 | Accept |
| Cognitive offload lens | Keep summary status mirrored into the rail so users do not rescan everything | 4 | 2 | 1 | Accept |

## Accepted Direction
- Eliminate false affordances.
- Reduce context loss after search and deep-link actions.
- Keep the shell predictable enough to build user muscle memory.
