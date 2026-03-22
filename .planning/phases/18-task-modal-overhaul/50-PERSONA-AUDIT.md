# 50 Persona Audit: Task Modal Overhaul

**Context:** The goal is to overhaul the New Task and Task Edit Modals in Meitheal, making them cleaner, better integrated with Strategic Lenses (Pillars, Principles, Goals), and maturing the look and feel (Glassmorphism, dark mode).

This audit explores 50 personas across UI, UX, ADHD, and Task Management to determine how to beat ClickUp while retaining Meitheal's unique Home Assistant-native, local-first ethos.

---

## Part 1: ADHD & Cognitive Load (15 Personas)
*Focus: Fast capture, reducing overwhelm, clear visual hierarchy.*

1. **The Overwhelmed Capture User:** Needs to dump thoughts fast without filling out 10 required fields. *Action: Title must auto-expand; only Title is required.*
2. **The "Out of Sight, Out of Mind" User:** If the save button is off-screen, the task doesn't get saved. *Action: Sticky footer for Save/Cancel actions.*
3. **The Distracted Context Switcher:** Opens the modal, gets distracted, comes back. Needs to instantly know what they were doing. *Action: Clear, bold typography and modal backdrop blur to isolate focus.*
4. **The Time Blind User:** Needs clear visual indicators for overdue tasks. *Action: Date pickers must use semantic language ("Tomorrow", "Next Week") and bold red for overdue.*
5. **The Paralysis-Prone User:** Dropping an old pending/active/completed dropdown for swimlanes reduces cognitive steps. *Action: Visual segmented pills for Status (Backlog, Todo, In Progress, Done).*
6. **The Visual Tracker:** Needs colors to mean something structural. *Action: Status dots/colors should globally map to Meitheal's theme (e.g., Purple for action, Cyan for progress).*
7. **The Quick-Key User:** Needs to rely on muscle memory. *Action: Keep CMD/CTRL+Enter to save.*
8. **The "Just One More Thing" User:** Needs to add multiple subtasks fast. *Action: Inline checklist creation must not require clicking a "New Item" button every time.*
9. **The Hyper-Focuser:** Wants to dive deep into a single task without distraction. *Action: Expanded modal width to allow side-by-side reading of description and comments/activity.*
10. **The Priority-Blind User:** Everything feels urgent. *Action: Priority icons must be instantly recognizable and hierarchical.*
11. **The Working Memory Deficit User:** Needs context for *why* a task exists. *Action: Strategic Lenses (Pillars/Goals) shouldn't be hidden in a submenu; they provide the "Why."*
12. **The Notification Fatigued User:** Doesn't want popups over popups. *Action: Avoid nested modals; use inline expansion or side panels within the main modal.*
13. **The Impatient Loader:** If the modal stutters, they bail. *Action: Astro HTML overhead must be minimal; modal should feel instant.*
14. **The "Too Many Tabs" User:** Needs the modal to stand out from the noise. *Action: Glassmorphism background blur (backdrop-filter) separates the modal from the app.*
15. **The Tactile Feedback Seeker:** Needs to know a button was clicked. *Action: Micro-animations on status clicks and saves.*

---

## Part 2: UI & Aesthetic Maturation (15 Personas)
*Focus: Modernizing, matching ClickUp's polish, retaining local-first speed.*

16. **The Dark Mode Enthusiast:** Expects deep blacks and glowing accents. *Action: Adopt the Neon Nocturne palette from Stitch (Deep charcoal #0E0E0E foundation, #C799FF primary).*
17. **The Typography Snob:** Hates cramped text. *Action: Use Manrope for Headers, Inter for Body. Title field must handle long text gracefully without truncating.*
18. **The Contrast Checker:** Needs to read text easily. *Action: Ensure 7:1 contrast on all primary text against the dark container.*
19. **The Space Maximizer:** Hates wasted whitespace but hates clutter. *Action: 2-column layout (Main details Left, Metadata/Strategy Right).*
20. **The ClickUp Defector:** Expects a unified, premium feel. *Action: Remove harsh 1px borders; use structural tonal layering and ghost borders (15% opacity text accents).*
21. **The Widescreen Monitor User:** A tiny center modal wastes space. *Action: Max-width: 4xl or larger for edit modals to utilize horizontal space.*
22. **The Mobile/Tablet User:** Needs touch targets. *Action: Ensure all form fields and pill selectors are at least 44px high.*
23. **The Hover-State Explorer:** Navigates by moving the mouse around. *Action: Interactive elements should have subtle background shifts on hover.*
24. **The Skimmer:** Looks for icons before text. *Action: Use consistent, high-quality icons for Strategic Lenses, Assignees, and Dates.*
25. **The Scroll Hater:** Wants everything visible at once. *Action: Make the description area flexible, but keep core metadata fixed.*
26. **The "Flat is Dead" User:** Wants depth. *Action: Use `surface_container_highest` for the modal with a diffused shadow.*
27. **The Alignment Perfectionist:** Misaligned labels drive them crazy. *Action: Strict grid system for the metadata right-column.*
28. **The Form Filler:** Hates clicking into a field and losing context. *Action: Floating labels or very clear placeholder text.*
29. **The "Cancel or Save?" User:** Needs distinct visual weight. *Action: Save = Solid gradient button. Cancel = Ghost/Glass button.*
30. **The Fluidity Lover:** Expects smooth transitions. *Action: Animate modal entry (fade-in, slide-up).*

---

## Part 3: UX & Task Management (10 Personas)
*Focus: Functional power, data integrity, seamless flows.*

31. **The Strategic Planner:** Connects tasks to life goals. *Action: Make Strategic Lenses, Pillars, and Principles a first-class citizen in the metadata column.*
32. **The Delegator (Home Assistant context):** Assigns tasks to household members. *Action: Assignee field must cleanly pull from HA users/Meitheal config.*
33. **The Context Switcher (Editing vs. Creating):** 'Create' needs to be fast; 'Edit' needs to be deep. *Action: Keep New Task modal focused; completely overhaul Edit Task to support the 2-column deep-dive.*
34. **The Markdown Writer:** Writes descriptions in markdown. *Action: Render markdown preview seamlessly in the modal.*
35. **The Tag/Label Organizer:** Relies heavily on taxonomy. *Action: Labels need a dedicated visual grouping, distinct from Pillars.*
36. **The Milestone Tracker:** Needs to know if a task is an Epic, Story, or Task. *Action: Clear visual indicator of the task's hierarchy level.*
37. **The Recurring Task Master:** Sets up "Take out trash every Tuesday." *Action: Semantic recurrence picker needs to be preserved but modernized visually.*
38. **The Dependency Manager:** Needs to see what block this task. *Action: "Relationships" section needs to clearly show blocking/blocked by.*
39. **The Activity Monitor:** Wants to know who changed what. *Action: Cleanly format the activity log at the bottom or in a dedicated tab.*
40. **The Fast Editor:** Wants to change a status without opening a sub-menu. *Action: Status swimlane pills make 1-click updates possible.*

---

## Part 4: Meitheal/Project Aspects & Competitor Parity (10 Personas)
*Focus: Beating ClickUp while staying true to the Meitheal architecture.*

41. **The "ClickUp is too Slow" User:** Hates the 3-second load times of cloud SaaS. *Action: Meitheal modal must load from local DOM/Astro instantly. Zero network wait to open the modal.*
42. **The Offline Worker:** Needs to log tasks when HA connection drops. *Action: Form inputs must be robust and queue if necessary, though HA integration is central.*
43. **The Data Privacy Advocate:** Wants HA local-first execution. *Action: No external CDNs for fonts/icons in the modal.*
44. **The Unified Dashboarder:** Wants the task modal to look like the rest of the new Unified Shell. *Action: Match rounding, padding, and colors of Phase 14 Unified Shell.*
45. **The "Everything is an Entity" User:** Treats tasks like HA entities. *Action: Future-proof the status swimlanes so they can map to HA Todo list statuses cleanly.*
46. **The RICE Evaluator:** Uses the Strategic Evaluator. *Action: The auto-score "AI" button for Strategic Lenses must be integrated cleanly into the strategy column.*
47. **The KCS Documentarian:** Wants knowledge capture in the task. *Action: Description field must encourage long-form context.*
48. **The Power Clicker:** Wants ClickUp's density but Notion's cleanliness. *Action: Achieve this through typographical hierarchy (Manrope + Inter) rather than lines/borders.*
49. **The Domain-Driven Designer (Me):** Needs the code separated cleanly. *Action: Keep `task-modal-controller.ts` logic out of the Astro UI component where possible; rely on the DOM for state to avoid React/Vue overhead.*
50. **The System Integrator (Me):** Needs the UI to drop into the existing pipeline. *Action: Use existing CSS variables, update `lexicon.ts` appropriately, and ensure the `NewTaskModal.astro` update doesn't break `timeline` or `kanban`.*

---

## Synthesis & Action Plan for the Modals

1.  **Architecture:**
    *   **New Task** = Clean, focused, center-screen. Expandable title, status swimlane pills.
    *   **Edit Task** = Expanded 2-column layout. Max-width `4xl`. Left side: Title, Description, Checklists. Right side: Metadata, Strategy (Pillars/Goals), Status, Priority, Dates.
2.  **UI/Design:** Implement the "Neon Nocturne" glassmorphism. Remove heavy borders, rely on tonal backgrounds (`bg-bg-card` -> `bg-bg-secondary`). Diffused drop-shadows.
3.  **Status Swimlanes:** Replace dropdown with a horizonal group of selectable pills (Backlog [Grey], Todo [Blue], In Progress [Yellow], Done [Green]).
4.  **Task Title:** `<textarea>` that auto-resizes based on content, removing truncation.
5.  **Strategic Lenses:** Elevate from a hidden popup to a dedicated section in the right column of the Edit modal. Allow selecting a Pillar, Principle, and scoring.
