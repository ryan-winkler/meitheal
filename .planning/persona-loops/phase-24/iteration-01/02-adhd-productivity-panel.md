# Panel 2: ADHD/Productivity — Phase 24, Iteration 01

**Objective:** Settings UI/UX, memory, click, and crash optimizations
**Date:** 2026-03-22

---

## Workflow Coach

**Recommendation:** Fix `SettingsLabels.renderLabels()` re-rendering the entire list on title edit, killing the user's cursor position

When a user types in a label title input (line 168-186), the debounced handler calls `renderLabels()` which replaces ALL innerHTML including the active input. The cursor jumps, focus is lost, and partially-typed text may be disrupted. This is a direct ADHD-hostile pattern — it punishes fast typing.

**Fix:** After a successful title edit API call, update only the badge `textContent` for that row (the preview badge), NOT the entire list. Only re-render on delete or create.

| Metric | Score |
|--------|-------|
| Impact | 5 |
| Effort | 2 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Typing in a label title input does not lose focus or cursor position.

---

## Execution Coach

**Recommendation:** Parallelize the 3 sequential `PUT /api/settings` calls in `SettingsAgents.saveBotBtn` handler

Lines 534-539 execute 3 PUT requests sequentially in a `for` loop. This triples the save latency (3 × RTT instead of 1 × RTT). On slow HA ingress connections this is noticeable.

**Fix:** Replace `for...of await` with `Promise.all()`.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 1 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Bot settings save uses `Promise.all()`, reducing save time to 1 RTT.

---

## Knowledge Coach

**Recommendation:** Add inline help text to Agent Token scopes explaining what each scope grants

The scope selector (lines 83-88) shows raw `tasks:read`, `settings:write` etc. with no explanation. A user unfamiliar with the API won't know what `pillars:write` or `admin:*` actually permits. This creates decision paralysis — particularly bad for ADHD users who need immediate clarity.

**Fix:** Add a `title` attribute or small desc text to each scope checkbox.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 2 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Each scope checkbox has a descriptive title/tooltip.

---

## Focus Optimizer

**Recommendation:** Disable the "Create Token" and "Create Label" submit buttons during API calls to prevent double-submission

`SettingsLabels` form submit (line 233) does not disable the button during the API call. Users who click twice get duplicate labels. `SettingsAgentTokens` DOES disable the save button (line 409-412) but is the only one that does correctly.

**Fix:** Add `disabled` during submit, re-enable in `finally` block — same pattern AgentTokens already uses.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 1 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Submit buttons are disabled during API calls; double-click produces one result.

---

## Automation Coach

**Recommendation:** Remove the `setTimeout` test result auto-clear in `SettingsAgents` (line 448-450) and replace with a dismissible inline message

Lines 448-450 auto-clear the test result after 5 seconds. If the user looks away (ADHD distraction), they miss the result entirely. This is especially bad for error results where the user needs to act.

**Fix:** Keep the result visible until the user takes another action (e.g., next test click, or save click). Clear on next interaction instead of timer.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 1 |
| Risk | 1 |
| **Decision** | **Accept** |

**Success criterion:** Test results persist until next user interaction, not on a 5-second timer.
