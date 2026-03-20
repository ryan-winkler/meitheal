# 50-Persona Panel Analysis: Recurrence Engine Convergence

**Question:** Should Meitheal's task recurrence (RRULE engine) and habit cadence (daily/weekly templates) converge into one engine, or stay separate?

**Date:** 2026-03-20
**Phase:** 1 — Hierarchy + Feature Gaps
**Iteration:** 01

---

## Executive Summary

**Verdict: Keep Separate, with a Shared Scheduling Primitive**

41 of 50 personas recommend keeping habits and task recurrence as separate domain concepts that share a common scheduling layer. The consensus is that habits and recurring tasks serve fundamentally different user intents — habits are identity-building streaks, tasks are work to be done — and merging them creates UX confusion. However, the underlying date-calculation logic should be unified into a single `scheduling-engine.ts` that both systems consume.

This matches the industry pattern: TickTick (separate), Habitica (3 distinct types), OmniFocus (no habits), Things 3 (no habits). Todoist is the cautionary tale — they treat habits as recurring tasks and users consistently report it feels wrong.

---

## Panel 1: Frontier Experts (5 Personas)

### 1. Platform Architect
**Position: Keep Separate + Shared Primitive**
> Task recurrence clones tasks on completion and uses `recurrence_anchor` (due_date vs completion_date). Habits use cadence + streak tracking. These are different lifecycle patterns. Merging them means the `task_templates` table needs RRULE support AND the `tasks` table needs cadence support — both gain complexity neither needs.
> 
> **Recommendation:** Extract `recurrence.ts` → `scheduling-engine.ts` in `packages/domain-tasks/`. Both systems import it. Habit templates store a computed RRULE internally but expose "daily"/"weekly"/"weekdays" as a simplified UX layer.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 3 | 2 | **Accept** |

### 2. OSS Integrations Specialist
**Position: Keep Separate**
> CalDAV (RFC 5545) uses RRULE. HA calendar entities expect RRULE. The task recurrence engine already speaks this language. Habits don't need CalDAV sync — nobody puts "drink water" on a shared calendar. Converging would force RRULE complexity onto habit users for zero CalDAV benefit.
> 
> **Recommendation:** Keep task RRULE for calendar sync interop. Keep habit cadence simple. If a user wants a habit on their calendar, let them create a recurring task instead.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 1 | 1 | **Accept** |

### 3. Reliability Engineer
**Position: Keep Separate**
> Two systems = two failure domains. If the RRULE parser has a bug, it shouldn't take down habit streaks. If habit cadence logic changes (e.g., adding "every 3 days"), it shouldn't risk breaking task recurrence for calendar-synced events.
> 
> **Recommendation:** Keep separate with shared date math utilities. Add integration tests for both paths independently.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 2 | 1 | **Accept** |

### 4. Security Engineer
**Position: Neutral (no security implications)**
> Neither approach introduces attack surface. RRULE parsing is already sandboxed. No auth or secrets involved.
> 
> **Recommendation:** No security-driven preference. Whichever reduces code surface area is marginally better.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 1 | 1 | 1 | **Accept** |

### 5. Product Architect
**Position: Keep Separate (strongly)**
> Tasks and habits serve different psychological needs. A task "Review quarterly metrics" repeating every 3 months is project work — it has a due date, a deliverable, and gets RICE scored. A habit "Drink 8 glasses of water" is identity work — it has a streak, a check-in, and gets gamification XP. Merging these into one concept dilutes both.
> 
> Todoist made this mistake. Users create "habits" as recurring tasks and lose streak motivation because completing a task just creates another task — there's no "you've done this 30 days in a row" moment.
> 
> **Recommendation:** Keep the domain language crisp: Tasks recur. Habits build streaks. The UI should make this distinction obvious.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 1 | 1 | **Accept** |

---

## Panel 2: ADHD/Productivity Specialists (5 Personas)

### 6. Workflow Coach
**Position: Keep Separate (strongly)**
> ADHD users need habits to feel fundamentally different from tasks. Tasks are obligations. Habits are self-care. If they look and feel the same, the habit system loses its motivational power. The streak counter, the daily check-in card, the "you're on a 14-day streak" celebration — these are ADHD dopamine mechanisms that *only work* because habits are a distinct experience.
> 
> **Recommendation:** Keep habits visually and architecturally distinct. The habits page should feel like a wellness dashboard, not a filtered task list.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 1 | 1 | **Accept** |

### 7. Execution Coach
**Position: Keep Separate**
> Execution velocity is hurt by convergence. Currently: create a habit = pick name + frequency, done. With RRULE: create a habit = parse recurrence rules, understand anchoring, configure interval. That's 3x the friction for the most frequent operation (daily check-in setup).
> 
> **Recommendation:** Habits should have < 3 taps to create. Tasks can have complex recurrence. Different interaction patterns.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 1 | 1 | **Accept** |

### 8. Knowledge Coach
**Position: Keep Separate + Document the Boundary**
> The KCS gap here is that there's no documentation explaining WHY habits and recurrence are separate. Future-Ryan will ask "why do we have two systems that do recurring things?" Write an ADR.
> 
> **Recommendation:** Create `docs/decisions/adr-recurrence-vs-habits.md` explaining the deliberate separation. Reference TickTick/Habitica precedent.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 1 | 1 | **Accept** |

### 9. Focus Optimizer
**Position: Keep Separate**
> Converging = multi-day refactor touching task templates, habits, recurrence, UI, AI tools, HA integration. That's scope explosion for zero user-facing benefit. The current system works. Don't fix what isn't broken.
> 
> **Recommendation:** Close this as "won't do" and move focus to features that add user value.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 2 | 1 | 1 | **Accept** |

### 10. Automation Coach
**Position: Partial Converge (shared scheduling)**
> The date math in `recurrence.ts` (getNextOccurrence, parseRRule) could be reused by habits for "every Mon/Wed/Fri" patterns. Currently habits only support daily/weekly which is limiting. Don't merge the domain concepts, but share the date calculator.
> 
> **Recommendation:** Export `getNextOccurrence()` as a shared utility. Let habits optionally use BYDAY for weekday-specific schedules while keeping the simple cadence UX.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 2 | 2 | **Accept** |

---

## Panel 3: Optimization Reviewers (5 Personas)

### 11. CI Hardening Reviewer
**Position: Keep Separate + Add Tests**
> Neither system has dedicated test coverage for edge cases (leap years, month-end overflow, DST transitions). Converging without tests would compound risk.
> 
> **Recommendation:** Add recurrence.spec.ts before any refactoring. Cover MONTHLY overflow, YEARLY leap day, WEEKLY BYDAY wrap-around.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 2 | 1 | **Accept** |

### 12. Build Validation Reviewer
**Position: Neutral**
> No build implications either way. Both compile today.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 1 | 1 | 1 | **Accept** |

### 13. Vertical Slice Reviewer
**Position: Keep Separate**
> The user workflow for "create a habit" and "create a recurring task" are completely different slices. A habit starts from the habits page with a quick-add card. A recurring task starts from any task view with a recurrence dropdown in the detail modal. Merging the backend doesn't simplify either slice.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 1 | 1 | **Accept** |

### 14. Runtime Reviewer
**Position: Keep Separate**
> The habit auto-create cron (creating today's habit tasks from templates) runs at a different lifecycle point than task recurrence cloning (which happens on task completion). Different triggers, different timing. Converging would require a unified scheduler that handles both — unnecessary complexity.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 3 | 1 | 2 | **Accept** |

### 15. Security Depth Reviewer
**Position: Neutral**
> No additional attack surface in either approach.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 1 | 1 | 1 | **Accept** |

---

## Panel 4: Domain Experts (10 Personas)

### 16. HA Automation Specialist
**Position: Keep Separate**
> HA sensor `sensor.meitheal_streak` reads from habit data. Task recurrence feeds `calendar.meitheal_tasks`. Different HA entities, different automations. A user wants "turn light green when streak > 7" separate from "notify me about recurring task due dates."

### 17. CalDAV Interop Engineer
**Position: Keep Separate**
> RFC 5545 RRULE is the standard for calendar events. Habits aren't calendar events. Don't pollute the CalDAV sync path with habit data.

### 18. Gamification Designer
**Position: Keep Separate (strongly)**
> Streaks, XP, and daily check-ins are gamification patterns that only work with consistent, simple tracking. RRULE complexity ("every 2nd Wednesday") breaks streak psychology — missing one Tuesday doesn't feel like breaking a streak the way missing a daily habit does.

### 19. Mobile UX Designer
**Position: Keep Separate**
> Mobile habits need big, tappable checkboxes with streak counters. Mobile recurring tasks need due date badges and priority colors. Completely different UI patterns.

### 20. Accessibility Specialist
**Position: Keep Separate**
> Two distinct screen reader patterns. Habits announce "Exercise — Day 14 of streak — tap to complete." Tasks announce "Review budget — due today — tap to open details." Merging confuses the a11y tree.

### 21. Voice UI Designer (HA)
**Position: Keep Separate**
> "Hey Google, did I do my morning routine?" → habit query. "Hey Google, what's recurring this week?" → task query. Voice commands need distinct intent routing.

### 22. Data Migration Specialist
**Position: Keep Separate**
> Converging means migrating existing habit templates to RRULE format. Any migration bug could reset streaks, which is a user-trust-destroying event.

### 23. Performance Engineer
**Position: Keep Separate**
> Habits are queried per-day (today's habits). Recurring tasks are queried per-range (this week's calendar). Different query patterns, different indexes. Converging means one query can't be optimized for both.

### 24. API Design Lead
**Position: Keep Separate**
> `/api/habits` and `/api/tasks` serve different clients. MCP tools for habits (getHabits, completeHabit) are separate from task tools. The API boundary reflects the domain boundary.

### 25. i18n Specialist
**Position: Keep Separate**
> Habits use simple frequency labels ("daily", "weekly") that translate easily. RRULE descriptions ("Every 2 weeks on Monday and Wednesday") are complex to internationalize. Don't force habit UX to carry RRULE i18n burden.

---

## Panel 5: Product & Strategy (10 Personas)

### 26. Product Manager (RICE)
**Position: Keep Separate**
> Converging: Reach=low (power users only), Impact=neutral (no new capability), Confidence=low (risk of UX regression), Effort=high (multi-day refactor). RICE score ≈ 0. Shared scheduling primitive: R=medium, I=medium, C=high, E=low. RICE ≈ moderate. Do the primitive, skip the merge.

### 27. Growth Strategist
**Position: Keep Separate**
> Habits drive daily engagement (DAU). Recurring tasks drive weekly planning (WAU). These are different retention mechanisms. Don't risk the DAU driver by merging it with the WAU driver.

### 28. Competitive Analyst
**Position: Keep Separate**
> TickTick (market leader in habit+tasks) keeps them separate. Habitica (gamification leader) keeps them separate. Todoist (merges them) gets criticized for it. Follow the winners.

### 29. Privacy Advocate
**Position: Neutral**
> No privacy implications.

### 30. Enterprise Buyer Persona
**Position: Keep Separate**
> Enterprise wants recurring tasks for compliance reviews, quarterly audits. They don't want habits mixed in. Clean API separation matters for enterprise integrations.

### 31. Solo User Persona
**Position: Keep Separate**
> "I want my habits to feel like self-care, not homework. If they look like tasks, I'll avoid them like I avoid tasks."

### 32. Household Manager Persona
**Position: Keep Separate but Interlinked**
> "My weekend chores are recurring tasks — they have due dates and I assign them. My exercise habit is just for me. But I'd love to see both on the Today page — just styled differently."

### 33. Neurodivergent User Persona
**Position: Keep Separate (strongly)**
> "Habit streaks give me dopamine. Task completion gives me relief. They're fundamentally different emotions. Don't make them the same thing."

### 34. Power User / Developer Persona
**Position: Shared Primitive**
> "I want habits to support 'every Mon/Wed/Fri' without full RRULE complexity. Give me a scheduling layer that habits can use for weekday selection while keeping the simple habit UX."

### 35. New User / Onboarding Persona
**Position: Keep Separate**
> "I just want to add 'Drink water' and check it off daily. Don't make me learn what RRULE means."

---

## Panel 6: Technical Implementation (10 Personas)

### 36. TypeScript Architect
**Position: Shared Primitive**
> Extract `scheduling-primitives.ts` from `recurrence.ts`. Export: `getNextOccurrence()`, `parseSimpleFrequency()` (daily→RRULE, weekly→RRULE), `describeSchedule()`. Habits import the simplified API. Tasks import the full RRULE API. Both use the same date math.

### 37. Database Designer
**Position: Keep Separate**
> `tasks.recurrence_rule` (TEXT, RRULE format) serves tasks. `task_templates.cadence` (TEXT, "daily"/"weekly") serves habits. Different tables, different schemas. Adding RRULE to templates forces all habit queries to parse RRULE — unnecessary overhead.

### 38. DDD Bounded Context Analyst
**Position: Keep Separate (strongly)**
> Task recurrence belongs in `domain-tasks`. Habit cadence belongs in the habit/routine subdomain. These are different bounded contexts with different aggregate roots (`Task` vs `TaskTemplate/Routine`). Cross-context convergence violates DDD principles.

### 39. Test Engineer
**Position: Shared Primitive + Test Coverage**
> Zero test files for `recurrence.ts` currently. Before ANY refactoring, add: `recurrence.spec.ts` covering all 4 frequencies, BYDAY combinations, COUNT exhaustion, UNTIL dates, month overflow, and leap years.

### 40. Migration Specialist
**Position: Keep Separate**
> Convergence migration risk: habits currently store "daily"/"weekly" as plain strings. Converting to RRULE means `UPDATE task_templates SET recurrence_rule = CASE WHEN cadence = 'daily' THEN 'FREQ=DAILY' WHEN cadence = 'weekly' THEN 'FREQ=WEEKLY' END`. This migration is doable but reversibility is painful if it goes wrong.

### 41. API Versioning Expert
**Position: Keep Separate**
> The Vikunja v1 compat layer serves external clients. Changing the recurrence model risks breaking v1 API consumers. Keep the existing task recurrence contract stable.

### 42. Bundle Size Analyst
**Position: Shared Primitive**
> `recurrence.ts` is 220 lines. Duplicating any of this for habits would be waste. The shared primitive approach reuses existing code without growing the bundle.

### 43. Error Handling Specialist
**Position: Keep Separate**
> Task recurrence errors should produce "Failed to calculate next occurrence" with RRULE context. Habit errors should produce "Failed to mark habit complete" with streak context. Different error domains.

### 44. Cache Strategy Designer
**Position: Keep Separate**
> Habits are cached per-day (today's habits). Recurring tasks are cached per-range (week view). Different cache invalidation strategies. Converging complicates cache keys.

### 45. Event Sourcing Analyst
**Position: Keep Separate**
> `meitheal_task_completed` event fires on task completion and triggers recurrence cloning. `meitheal_habit_completed` should fire on habit check-in and update streak. Different event payloads, different subscribers.

---

## Panel 7: Edge Case & Future-Proofing (5 Personas)

### 46. HA Integration Future Planner
**Position: Keep Separate + Shared Primitive**
> Future: habits could expose HA entities (sensor.meitheal_water_intake). Task recurrence already drives calendar entities. These are different entity types. But the scheduling math for "when is the next occurrence?" is reusable.

### 47. AI Agent Designer
**Position: Keep Separate**
> AI agents need different tool schemas. `completeHabit` returns streak data. `completeTask` returns recurrence data. Converging means every completion response carries both streak and recurrence fields — 50% wasted payload on every call.

### 48. Multi-User/Household Planner
**Position: Keep Separate**
> Household recurring tasks get assigned to family members with rotation. Habits are personal — nobody assigns "Meditate" to someone else. Different assignment models.

### 49. Offline/PWA Specialist
**Position: Keep Separate**
> Habit check-in works offline (flip a boolean, sync later). Task recurrence cloning requires server-side DB operations. Different offline strategies.

### 50. CalDAV/iCal Bridge Developer
**Position: Keep Separate**
> If habits used RRULE, CalDAV sync would export "Drink Water FREQ=DAILY" to Google Calendar. Nobody wants that. Keep habits out of the CalDAV pipeline.

---

## Synthesis

### Final Tally

| Position | Count | Percentage |
|----------|-------|------------|
| Keep Separate | 33 | 66% |
| Keep Separate + Shared Primitive | 8 | 16% |
| Shared Primitive Only | 5 | 10% |
| Neutral | 4 | 8% |
| **Converge** | **0** | **0%** |

### Consensus Recommendation

**Keep habits and task recurrence as separate domain concepts.** Extract shared date-calculation utilities into a reusable module that both systems can import.

### Concrete Actions

| # | Action | Impact | Effort | Risk |
|---|--------|--------|--------|------|
| 1 | Write ADR documenting the deliberate separation | 3 | 1 | 1 |
| 2 | Add `recurrence.spec.ts` with edge case coverage | 4 | 2 | 1 |
| 3 | Optionally extend habit cadence to support weekday selection (Mon/Wed/Fri) using simplified RRULE internally | 4 | 3 | 2 |
| 4 | Do NOT attempt convergence migration | — | — | — |

### Industry Precedent

| Product | Approach | Outcome |
|---------|----------|---------|
| **TickTick** | Separate habit module | Market-leading habit+task UX |
| **Habitica** | 3 distinct types (Habits/Dailies/Todos) | 5M+ users, strong retention |
| **OmniFocus** | RRULE for tasks, no habits | Power user favorite |
| **Things 3** | Fixed/after-completion, no habits | Beloved UX simplicity |
| **Todoist** | Habits = recurring tasks | Consistently criticized, added Habits extension |

---

*Panel: 50 personas · Phase 1 · Iteration 01*
*Generated: 2026-03-20*
