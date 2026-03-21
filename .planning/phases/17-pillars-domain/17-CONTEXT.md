# Phase 17: Pillars Domain - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Introduce a complete "Pillars & Principles" domain into Meitheal — the WHY layer that sits above and across Goals, Routines, and Tasks. This phase delivers:

1. **Pillars** — permanent, identity-based motivational anchors ("Physical Longevity", "Unbreakable Family")
2. **Principles/Non-Negotiables** — absolute behavioral boundaries within each Pillar ("Never sacrifice 8 hours of sleep for a deadline")
3. **North Star UI** — a visually inspiring masonry/manifesto page, not a task list
4. **Cross-domain linkage** — Pillars connect to Goals, Routines, Tasks via M2M associations with top-down inheritance
5. **AI/Agent integration** — Principles injected into LLM system prompts for scheduling guardrails
6. **Strategic evaluator upgrade** — Pillar-weighted priority boosting in Eisenhower/ICE engines
7. **Conflict resolution UX** — non-blocking warnings when scheduled actions violate Principles
8. **Alignment audit** — weekly balance visualization across Pillars

</domain>

<decisions>
## Implementation Decisions

### Ubiquitous Language (LOCKED)

| Term | Definition | Example |
|------|-----------|---------|
| **Pillar** | The Identity / The Why — load-bearing, infinite categories of a life | "Physical Longevity", "Financial Independence", "Unbreakable Family" |
| **Principle** (or **Non-Negotiable**) | The Boundary — absolute rules governing behavior within a Pillar | "Never sacrifice 8 hours of sleep for a deadline", "Sunday dinner is sacred" |
| **Goal** | The Destination — time-bounded or aspirational outcome | "Drop to 15% body fat by June" |
| **Routine** | The Automation — recurring daily/weekly behaviors | "Gym at 6 AM M/W/F" |
| **Task** | The Action — atomic unit of work | "Buy protein powder today" |
| **Area** | Life buckets — broad categories | Work, Kids, Home, House |

### Data Model (LOCKED)

- Pillars are a separate bounded context: `domains/pillars/`
- Principles/Non-Negotiables are child entities of Pillars (1:N)
- M2M associations via `pillar_associations` join table
- Top-down inheritance: Tasks inherit Pillar of parent Project/Goal
- Orphaned tasks allowed — "Take out the trash" doesn't need a Pillar
- Orphaned tasks visually flagged as "Unaligned" (gamification signal, not shame)

### UI/UX (LOCKED)

- **North Star page** as the primary Pillars view — large, visually inspiring cards (masonry grid or "Personal Manifesto" style)
- Do NOT style like a Kanban or task list (no `TasksTableView.astro` patterns)
- Use `CardCustomizer.astro` as design reference for card presentation
- **Blueprint View**: clicking a Pillar shows: the WHY, Principles, and dynamically rolled-up list of active Goals, Habits, Tasks
- **Alignment Audit** in `progress.astro`: chart showing upcoming week balance across Pillars with warnings (e.g., "85% routines tied to Wealth, 0% to Health")

### AI/Agent Integration (LOCKED)

- Inject Principles into LLM system prompts via `ai-context-service.ts`
- AI must push back on schedule changes that violate Non-Negotiables
- Example: "You have a Non-Negotiable rule to protect Thursday evenings for family. Should I suggest Friday morning instead?"

### Strategic Evaluator Upgrade (LOCKED)

- Add pre-computation step in `rule-resolver.ts`
- Tasks attached to high-weight Pillars or upholding Non-Negotiable Principles get priority score boost
- Automatically pushes Pillar-aligned tasks up in `today-focus-stack.ts`

### Conflict Resolution (LOCKED)

- Never hard-block users (life happens, EAs need flexibility)
- High-visibility warning: "Boundary Conflict: This violates your 'Family Weekends' principle. Proceed?"
- Warning is dismissible but logged

### Onboarding (LOCKED)

- AI onboarding wizard for the "blank page" problem
- Behavioral questions: "What boundary did you let someone cross last week that you wish you hadn't?"
- AI drafts Pillars and Principles from answers

### Inheritance Model (LOCKED)

- Tasks inherit Pillar from parent Project → Goal chain
- Explicit Pillar assignment overrides inherited
- "Unaligned" visual flag on tasks without any Pillar (direct or inherited)

### Claude's Discretion

- Number of sub-phases and wave structure
- Specific component naming beyond the established ubiquitous language
- Internal algorithm for Pillar-weight boosting in strategic evaluator
- Alignment audit visualization chart type (bar, radar, etc.)

</decisions>

<specifics>
## Specific Ideas

- The "Personal Manifesto" document style for the North Star page — think identity statement board, not a spreadsheet
- `CardCustomizer.astro` as the design reference for Pillar cards — large, bold, colorful
- Alignment audit similar to a fitness app's weekly breakdown — visual balance wheel or bar chart
- AI onboarding wizard should feel like a coaching conversation, not a form

</specifics>

<deferred>
## Deferred Ideas

- Household sharing of Pillars (multi-user scope — requires auth overhaul)
- HA entity exposure of Pillars as sensors (requires integration-core changes)
- Advanced analytics and trending over time
- Pillar-based filtering on task views (filter chips)
- WebMCP integration for external agent access to Principles
- Node-RED / n8n automation triggers based on Principle violations

</deferred>

---

*Phase: 17-pillars-domain*
*Context gathered: 2026-03-21*
