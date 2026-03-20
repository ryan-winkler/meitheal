# Panel 2: ADHD/Productivity Specialists

**Objective:** Hierarchy Architecture Overhaul — three parent pages, pinnable sub-menus, routine templates, Gantt
**Phase:** 15 · **Iteration:** 01

---

## 1. Workflow Coach

**Recommendation:** Make the "Every Day" project the default landing context when opening the sidebar or quick-creating a task, so unassigned captures go to "Every Day" without requiring the user to think about project assignment.

**Rationale:** ADHD users abandon task capture when forced to categorize before saving. "Every Day" as the default means capturing is always one step (title → Enter). Users can re-file later during triage.

**Success Criterion:** Creating a task via quick-add with no project selected assigns it to "Every Day" automatically. Verified in both sidebar and keyboard shortcut paths.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 1 | 1 | **Accept** |

---

## 2. Execution Coach

**Recommendation:** Add a "daily routine check-in" section to the Today page that shows pending routine instances with one-tap complete, positioned above the task list as a warm-up activity.

**Rationale:** ADHD users struggle with cold starts. Routine check-in provides a sequence of small wins (complete → streak update → dopamine) that builds momentum before tackling the task list. This is the "2-minute rule" in practice.

**Success Criterion:** Today page shows a collapsible "Routines" section at the top with pending routine instances. Completing one updates the streak badge in real-time.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 3 | 2 | **Accept** |

---

## 3. Knowledge Coach

**Recommendation:** Add a hierarchy relationship indicator to the task detail modal that shows: Area → Goal → Project → Task breadcrumb, making the context of any task immediately visible without navigating away.

**Rationale:** ADHD users lose context rapidly. Seeing "Home → Stay Healthy → Meal Prep → Buy groceries" in the task detail answers "why am I doing this?" instantly, which combats task-switching fatigue.

**Success Criterion:** Task detail modal displays breadcrumb showing the full hierarchy path from Area to Task. Links in breadcrumb navigate to the parent entity.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 4 | 2 | 1 | **Accept** |

---

## 4. Focus Optimizer

**Recommendation:** Limit the sidebar to 6 primary nav items post-consolidation (Dashboard, Today, Upcoming, Tasks, Progress & Growth, Planning) with collapsed state as default, and show pinned sub-menus only when the sidebar is expanded.

**Rationale:** ADHD is worsened by visual noise. The current 11-item sidebar is a decision-paralysis generator. 6 items fits the working memory sweet spot (7±2). Pinned sub-menus only appear when sidebar is expanded, keeping the collapsed state clean.

**Success Criterion:** Collapsed sidebar shows exactly 6 icons. Expanded sidebar shows the 6 items plus any pinned sub-menus indented beneath their parent.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 2 | 2 | **Accept** |

---

## 5. Automation Coach

**Recommendation:** Implement a "Routine auto-spawn" scheduler that runs at page load (not a cron job), checking `routine_templates` for today's due instances and creating them if missing, so routine tasks appear without manual intervention.

**Rationale:** ADHD users won't remember to "spawn" routine instances manually. Auto-spawn on page load means opening Meitheal = today's routines are ready. No ceremony, no forgotten steps.

**Success Criterion:** After midnight, opening any Meitheal page automatically creates today's due routine instances. No user action required.

| Impact | Effort | Risk | Decision |
|--------|--------|------|----------|
| 5 | 3 | 3 | **Accept** |

---

**Panel Summary:** 5 Accepted, 0 Deferred, 0 Rejected

**Capture/Triage improvement (required):** Recommendation #1 (Every Day as default capture target) directly improves capture flow — no categorization friction.
