# Pillars Domain — Features Research

**Date:** 2026-03-21
**Researcher:** Antigravity (50-persona audit + competitive analysis)

## Table Stakes (Must-Have for V1)

| Feature | Description | Persona Support |
|---------|-------------|----------------|
| Pillar CRUD | Create, edit, delete, reorder Pillars | 50/50 |
| Name + Icon + Color | Visual identity per Pillar | 48/50 |
| Max 7 limit | Cognitive load guard (soft or hard) | 42/50 |
| Goal linkage | Optional `pillar_id` on Goals table | 47/50 |
| Routine linkage | Optional `pillar_id` on task_templates/habits | 45/50 |
| Pillar list page | `/progress` sub-section for Pillars | 50/50 |
| Pillar detail view | Show connected Goals, Routines, Tasks | 44/50 |
| Identity framing | "I am someone who..." language | 38/50 |
| Shame-free design | No failure states, only positive anchors | 46/50 |

## Should-Have (V1 if feasible, otherwise V2)

| Feature | Description | Persona Support |
|---------|-------------|----------------|
| Task linkage | Optional `pillar_id` on Tasks (beyond goal inheritance) | 30/50 |
| Pillar filter chip | Filter any view by Pillar | 35/50 |
| Contextual badge | Show Pillar color dot on task detail panel | 32/50 |
| Onboarding suggestions | Auto-suggest Pillars from existing Areas | 28/50 |
| Pillar description | Optional description/identity statement | 40/50 |

## Differentiators (V2+)

| Feature | Description | Persona Support |
|---------|-------------|----------------|
| Pillar attention radar | N-sided polygon visualization showing time balance | 25/50 |
| Weekly review panel | "Time spent per Pillar" analytics | 30/50 |
| Pillar-aligned RICE modifier | Pillar alignment boosts prioritization score | 20/50 |
| HA sensors | `sensor.meitheal_pillar_{slug}_attention` | 18/50 |
| Keystone badge | Tag routines serving 2+ Pillars | 15/50 |
| Household sharing | Shared vs. personal Pillars | 22/50 |
| Calendar color-coding | Calendar events tinted by Pillar color | 12/50 |

## Anti-Features (Explicitly NOT building)

| Feature | Reason |
|---------|--------|
| Pillar streak counter | Shame-inducing. Pillars are permanent, not performative. |
| Pillar failure notifications | "You haven't served your Health Pillar" = harmful for ADHD. |
| Mandatory Pillar assignment | Tasks without Pillars are fine. Gentle prompt only. |
| Complex Pillar hierarchy | Pillars are flat. No sub-pillars. Simplicity is key. |
| Pillar-based task auto-creation | Pillars don't create tasks. Routines do. |

## Competitive Landscape

| App | Has Values/Pillars? | Implementation |
|-----|---------------------|----------------|
| TickTick | ❌ No — tags/lists only | Gap |
| Todoist | ❌ No — projects as categories | Gap |
| Habitica | ❌ No — gamification only | Gap |
| Things 3 | ❌ No — areas only | Gap |
| OmniFocus | ❌ No — contexts/tags | Gap |
| Notion | ⚠️ DIY — users build it manually | Unstructured |
| Serenity Coach | ✅ Yes — "Life Values" | Specialized wellness app |
| maLife | ✅ Yes — "Life Areas with Vision" | Specialized life planning |

**Market opportunity: No major task management app has a structured values/pillars layer.**

## Confidence: HIGH
Features well-validated by 50-persona panel and competitive gap analysis.
