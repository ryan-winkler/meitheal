# GSD Plan & Tasks — Sidebar Iteration 01

**Source**: Frontier Panel + ADHD Panel  
**Accepted**: 6 tasks  
**Deferred**: 4 tasks (to backlog)  

---

## Accepted Tasks (Execute This Iteration)

### T1: Replace `prompt()` with inline editable inputs [P0]
**Source**: Frontier #2, ADHD #2  
**Scope**: Replace 4 `prompt()` calls with inline `<input>` elements that appear in-context:
- New project (area +): inline input appears below area 
- Rename area: name text converts to editable input
- Rename project: name text converts to editable input
- New task (after kind selection): inline input in sidebar
**i18n**: Move prompt strings to i18n keys (ADHD #4) 
**GSD Command**: `/gsd-execute-phase`

### T2: Replace `confirm()` with inline confirmation [P0]
**Source**: Frontier #4  
**Scope**: Area delete confirmation becomes a 2-step inline: first click shows "Delete?" button instead of native confirm
**GSD Command**: `/gsd-execute-phase`

### T3: Add error toast on API failure [P1]
**Source**: Frontier #3  
**Scope**: Create or reuse a toast/snackbar utility. Wire into all 6 `catch {}` blocks.
**GSD Command**: `/gsd-execute-phase`

### T4: Add "Delete Project" to project menu [P1]
**Source**: Frontier #5  
**Scope**: Add delete action to project ⋯ dropdown with inline confirmation. Wire to `DELETE /api/projects/:id`.
**GSD Command**: `/gsd-execute-phase`

### T5: Add pinned section discoverability tooltip [P2]
**Source**: ADHD #3  
**Scope**: Add `title` or small "?" help indicator to pinned section explaining right-click to pin.
**GSD Command**: `/gsd-execute-phase`

### T6: Wire remaining JS hardcoded strings to i18n [P2]
**Source**: ADHD #4  
**Scope**: All English strings in `<script>` section → i18n system. This includes prompt placeholders that become input placeholders.
**GSD Command**: `/gsd-execute-phase`

---

## Deferred Tasks (Backlog)

| Task | Source | Trigger |
|------|--------|---------|
| Replace `window.location.reload()` with DOM updates | Frontier #1, ADHD #5 | After inline inputs are working |
| Quick-capture keyboard shortcut | ADHD #1 | After inline input infrastructure |
