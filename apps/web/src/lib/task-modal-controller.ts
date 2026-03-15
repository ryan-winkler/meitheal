        import { askAIForTask } from "@domains/ai/ai-context-service";
        import {
          saveAttachment,
          getAttachmentsByTaskId,
          deleteAttachment,
        } from "@domains/offline/offline-store";
        import { confirmDialog } from "@lib/confirm-dialog";
        import { pageLifecycle } from "@lib/page-lifecycle";
        import { marked } from "marked";
        import { sanitizeClient } from "@lib/sanitize-client";
        import { onTaskCompleted } from "@lib/gamification-hook";
        import { createFocusTrap } from "@lib/focus-trap";
        import { renderTypeIconSvg } from "@lib/type-icon-config";

        // Use lifecycle signal for all global listeners in this module
        const __signal = pageLifecycle.signal;

        // === Task Detail Panel ===
        const tdOverlay = document.getElementById(
          "task-detail-overlay",
        ) as HTMLDivElement;
        let currentTaskId: string | null = null;
        let _isPopulating = false;
        // P3-4/P22: Focus management — restore focus to trigger element on panel close
        let _previouslyFocused: Element | null = null;
        let _settingsFields: Array<{
          name: string;
          type: string;
          options?: string[];
        }> = [];
        const RICE_KEYS = ["Reach", "Impact", "Confidence", "Effort"];

        function closeTD() {
          tdOverlay?.classList.add("hidden");
          currentTaskId = null;
          // Always reset body overflow to restore page scrolling
          document.body.style.overflow = "";
          history.pushState(null, "", window.location.pathname);
          // P3-4: Restore focus to the element that triggered the panel
          if (_previouslyFocused && _previouslyFocused instanceof HTMLElement) {
            _previouslyFocused.focus();
            _previouslyFocused = null;
          }
        }

        async function openTaskDetail(taskId: string) {
          if (!tdOverlay) return;
          // P3-4: Store focus origin for restore on close
          _previouslyFocused = document.activeElement;
          currentTaskId = taskId;
          _isPopulating = true;
          tdOverlay.classList.remove("hidden");
          // Lock body scroll while panel is open (closeTD restores it)
          document.body.style.overflow = "hidden";
          // Set dynamic aria-label for screen readers
          tdOverlay.setAttribute("aria-label", `Task detail: loading...`);

          try {
            // Populate status dropdown from lanes API
            const statusSelect = document.getElementById(
              "td-status",
            ) as HTMLSelectElement | null;
            try {
              const [lanesRes, modeRes] = await Promise.all([
                fetch((window.__ingress_path || "") + "/api/lanes"),
                fetch(
                  (window.__ingress_path || "") +
                    "/api/settings?key=backlog_mode",
                ),
              ]);
              let backlogMode = "visible";
              try {
                if (modeRes.ok) {
                  const md = await modeRes.json();
                  if (md.value === "hidden" || md.value === "disabled")
                    backlogMode = md.value;
                }
              } catch {
                /* default */
              }
              if (lanesRes.ok && statusSelect) {
                const lanesData = await lanesRes.json();
                let lanes = lanesData.lanes || [];
                // When backlog is disabled, remove it from status options
                if (backlogMode === "disabled") {
                  lanes = lanes.filter((l: any) => l.key !== "backlog");
                }
                statusSelect.innerHTML = "";
                for (const lane of lanes) {
                  // Add the main key as an option
                  const opt = document.createElement("option");
                  opt.value = lane.key;
                  opt.textContent = `${lane.icon} ${lane.label}`;
                  statusSelect.appendChild(opt);
                }
              }
            } catch {
              /* keep existing options */
            }

            const res = await fetch(
              `${window.__ingress_path || ""}/api/tasks/${taskId}`,
            );
            if (!res.ok) {
              closeTD()
              const { showToast } = await import("@lib/toast")
              showToast("common.failed", "error")
              return
            }
            const t = (await res.json()) as Record<string, unknown>;

            if (t.id) currentTaskId = String(t.id);
            // Update URL hash to prioritize human-readable MTH IDs
            const hashId = t.ticket_key ? String(t.ticket_key) : String(t.id);
            if (window.location.hash !== `#task-${hashId}`) {
              history.pushState(null, "", `#task-${hashId}`);
            }

            const parentEl = document.getElementById(
              "td-parent",
            ) as HTMLAnchorElement | null;
            if (parentEl && t.parent_id) {
              parentEl.textContent = `↑ ${t.parent_ticket_key ?? t.parent_title ?? t.parent_id}`;
              parentEl.href = `#task-${t.parent_id}`;
              parentEl.classList.remove("hidden");
              parentEl.classList.add("flex");
              parentEl.onclick = (e) => {
                e.preventDefault();
                openTaskDetail(String(t.parent_id));
              };
            } else if (parentEl) {
              parentEl.classList.add("hidden");
              parentEl.classList.remove("flex");
            }

            // Linked Tickets — parent display
            const linkParentDisplay = document.getElementById(
              "td-link-parent-display",
            ) as HTMLElement;
            if (linkParentDisplay) {
              if (t.parent_id) {
                const parentTitle = String(
                  t.parent_ticket_key ??
                    t.parent_title ??
                    String(t.parent_id).slice(0, 8),
                );
                linkParentDisplay.innerHTML = `
                <a href="#" class="text-xs text-accent hover:underline td-parent-link" data-id="${t.parent_id}">${parentTitle}</a>
                <button type="button" class="text-xs text-danger hover:text-red-400 ml-1 td-unlink-parent" title="Remove parent">✕</button>
              `;
                linkParentDisplay
                  .querySelector(".td-parent-link")
                  ?.addEventListener("click", (e) => {
                    e.preventDefault();
                    openTaskDetail(String(t.parent_id));
                  });
                linkParentDisplay
                  .querySelector(".td-unlink-parent")
                  ?.addEventListener("click", async () => {
                    if (
                      await confirmDialog({
                        message: t.title
                          ? `Unlink parent from "${t.title}"?`
                          : "Unlink parent?",
                        title: "Unlink",
                      })
                    ) {
                      await fetch(
                        `${window.__ingress_path || ""}/api/tasks/${currentTaskId}`,
                        {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ parent_id: null }),
                        },
                      );
                      openTaskDetail(String(currentTaskId));
                    }
                  });
              } else {
                linkParentDisplay.innerHTML =
                  '<span class="text-xs text-text-muted italic">None</span>';
              }
            }

            // --- Offline Attachments - Document Preview & Kanban Card Cover (Phase 23) ---
            (async function renderThumbnails() {
              // Restore thumbnail logic later if needed
            })();

            // Linked Tickets — children
            const childrenDiv = document.getElementById(
              "td-link-children",
            ) as HTMLElement;
            if (childrenDiv) {
              childrenDiv.innerHTML = "";
              // Progress bar elements
              const progressWrap = document.getElementById("td-subtask-progress");
              const progressLabel = document.getElementById("td-subtask-progress-label");
              const progressBar = document.getElementById("td-subtask-progress-bar");
              try {
                const childRes = await fetch(
                  `${window.__ingress_path || ""}/api/tasks?parent_id=${taskId}`,
                );
                if (childRes.ok) {
                  const childData = await childRes.json();
                  const children = childData.tasks ?? [];
                  if (children.length === 0) {
                    childrenDiv.innerHTML = `<span class="text-xs text-text-muted italic">No children</span>`;
                    if (progressWrap) progressWrap.classList.add("hidden");
                  } else {
                    let doneCount = 0;
                    children.forEach((c: Record<string, unknown>) => {
                      const isDone = c.status === "complete";
                      if (isDone) doneCount++;
                      const chip = document.createElement("a");
                      chip.href = "#";
                      chip.className = `text-xs block flex items-center gap-1 ${isDone ? "text-text-muted line-through" : "text-accent hover:underline"}`;
                      const typeIcon = c.task_type === "epic" ? "🎯" : c.task_type === "story" ? "📖" : "";
                      const statusIcon = isDone ? "✓" : "⏳";
                      chip.textContent = `${statusIcon} ${typeIcon}${typeIcon ? " " : ""}↳ ${c.ticket_key ? c.ticket_key + " " : ""}${String(c.title ?? c.id).slice(0, 50)}`;
                      chip.addEventListener("click", (e) => {
                        e.preventDefault();
                        openTaskDetail(String(c.id));
                      });
                      childrenDiv.appendChild(chip);
                    });
                    // Update progress bar (SUB-03)
                    if (progressWrap && progressLabel && progressBar) {
                      progressWrap.classList.remove("hidden");
                      progressLabel.textContent = `${doneCount}/${children.length}`;
                      const pct = Math.round((doneCount / children.length) * 100);
                      progressBar.style.width = `${pct}%`;
                      // Color coding: green if all done, yellow if partial, default if none
                      if (pct === 100) progressBar.className = "h-full bg-green-500 rounded-full transition-all duration-300";
                      else if (pct > 0) progressBar.className = "h-full bg-amber-500 rounded-full transition-all duration-300";
                      else progressBar.className = "h-full bg-accent rounded-full transition-all duration-300";
                    }
                  }
                }
              } catch {
                childrenDiv.innerHTML = `<span class="text-xs text-text-muted italic">—</span>`;
                if (progressWrap) progressWrap.classList.add("hidden");
              }
            }

            // Activity Log (ADR-0011) — lazy-loaded on expand
            const activityDiv = document.getElementById(
              "td-activity",
            ) as HTMLElement;
            const activityDetails = activityDiv?.closest("details");
            if (activityDetails && activityDiv) {
              activityDiv.innerHTML = "";
              const loadActivity = async () => {
                try {
                  const actRes = await fetch(
                    `${window.__ingress_path || ""}/api/tasks/${taskId}/activity`,
                  );
                  if (!actRes.ok) return;
                  const actData = await actRes.json();
                  const entries = Array.isArray(actData)
                    ? actData
                    : (actData.activity ?? []);
                  if (!Array.isArray(entries) || entries.length === 0) {
                    activityDiv.innerHTML = `<span class="text-text-muted italic">No activity yet</span>`;
                    return;
                  }
                  activityDiv.innerHTML = "";
                  for (const e of entries.slice(0, 50)) {
                    const ago = new Date(Number(e.created_at)).toLocaleString();
                    const row = document.createElement("div");
                    row.className =
                      "flex gap-2 items-baseline py-1 border-b border-border/30";
                    row.innerHTML = `
                    <span class="text-text-muted shrink-0">${ago}</span>
                    <span class="font-medium text-text-primary">${String(e.field)}</span>
                    <span class="text-text-muted">→</span>
                    <span class="text-accent truncate">${String(e.new_value ?? "—").slice(0, 60)}</span>
                  `;
                    activityDiv.appendChild(row);
                  }
                } catch {
                  activityDiv.innerHTML = `<span class="text-text-muted italic">—</span>`;
                }
              };
              // Lazy load: only fetch when expanded
              activityDetails.addEventListener(
                "toggle",
                () => {
                  if (activityDetails.open) loadActivity();
                },
                { once: true },
              );
            }

            // Load related links (Jira-style issue linking)
            if (typeof loadRelatedLinks === "function")
              loadRelatedLinks(taskId);

            // ID — hidden, accessible via tooltip
            const tdAnchor = document.getElementById("td-ticket-anchor");
            if (tdAnchor) {
              tdAnchor.textContent = t.ticket_key
                ? String(t.ticket_key)
                : (String(t.id).split("-")[0] ?? "");
              tdAnchor.onclick = async () => {
                navigator.clipboard.writeText(
                  t.ticket_key ? String(t.ticket_key) : String(t.id),
                );
                const { showToast } = await import("@lib/toast");
                showToast("common.id_copied", "success");
              };
            }
            const tdIdEl = document.getElementById(
              "td-id",
            ) as HTMLElement | null;
            if (tdIdEl) {
              tdIdEl.textContent = t.ticket_key
                ? String(t.ticket_key)
                : `#${String(t.id).slice(0, 8)}`;
              tdIdEl.title = `${t.ticket_key ? String(t.ticket_key) + " • " : ""}Full ID: ${t.id}`;
              tdIdEl.classList.remove("hidden");
            }

            // Render type icon (shared config from @lib/type-icon-config)
            const typeIconEl = document.getElementById("td-type-icon") as HTMLElement | null;
            if (typeIconEl) {
              const tt = String(t.task_type || "task").toLowerCase();
              typeIconEl.innerHTML = renderTypeIconSvg(tt, 16);
              typeIconEl.title = tt.charAt(0).toUpperCase() + tt.slice(1);
            }

            const titleEl = document.getElementById("td-title") as HTMLTextAreaElement;
            if (titleEl) {
              titleEl.value = String(t.title ?? "");
              // Trigger auto-resize inline
              titleEl.style.height = "auto";
              // Brief timeout to ensure DOM layout is updated before scrollHeight is read
              setTimeout(() => {
                titleEl.style.height = titleEl.scrollHeight + "px";
              }, 10);
            }
            // Update aria-label with actual task title for screen readers
            tdOverlay?.setAttribute("aria-label", `Task detail: ${String(t.title ?? "Untitled")}`);

            // Priority dot color
            const priorityDot = document.getElementById(
              "td-priority-dot",
            ) as HTMLElement;
            const priorityColors: Record<string, string> = {
              "1": "var(--prio-critical, #ef4444)",
              "2": "var(--prio-high, #f97316)",
              "3": "var(--prio-medium, #eab308)",
              "4": "var(--prio-low, #22c55e)",
              "5": "var(--prio-none, #6b7280)",
            };
            const pVal = String(t.priority ?? 3);
            if (priorityDot) {
              priorityDot.style.color = priorityColors[pVal] || "var(--prio-medium, #eab308)";
              priorityDot.title = `Priority ${pVal}`;
            }

            // If the task's status isn't in the dropdown, add it as an option
            const taskStatus = String(t.status ?? "pending");
            if (
              statusSelect &&
              !statusSelect.querySelector(`option[value="${taskStatus}"]`)
            ) {
              const opt = document.createElement("option");
              opt.value = taskStatus;
              opt.textContent = taskStatus;
              statusSelect.appendChild(opt);
            }
            if (statusSelect) statusSelect.value = taskStatus;
            const tdDesc = document.getElementById(
              "td-description",
            ) as HTMLTextAreaElement;
            tdDesc.value = String(t.description ?? "");

            // Switch to preview mode automatically when opening a task that has a description
            if (t.description) {
              document.getElementById("td-desc-preview-btn")?.click();
            } else {
              document.getElementById("td-desc-edit-btn")?.click();
            }

            (
              document.getElementById("td-priority") as HTMLSelectElement
            ).value = String(t.priority ?? 3);
            const progress = Number(t.progress ?? 0);
            (document.getElementById("td-progress") as HTMLInputElement).value =
              String(progress);
            const progValEl = document.getElementById("td-progress-value");
            if (progValEl) progValEl.textContent = `${progress}%`;

            // Progress bar fill
            const progressBarFill = document.getElementById(
              "td-progress-bar-fill",
            ) as HTMLElement;
            if (progressBarFill) {
              progressBarFill.style.width = `${progress}%`;
              progressBarFill.style.background =
                progress === 100 ? "var(--success)" : "var(--accent)";
            }

            // Due date display with relative time
            const dueRow = document.getElementById("td-due-row") as HTMLElement;
            const dueDisplay = document.getElementById(
              "td-due-display",
            ) as HTMLElement;
            const dueVal = String(t.due_date ?? "");
            if (dueVal && dueRow && dueDisplay) {
              const dueDate = new Date(dueVal);
              const now = new Date();
              const diffDays = Math.ceil(
                (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
              );
              let relText = "";
              if (diffDays < 0) relText = `${Math.abs(diffDays)}d overdue`;
              else if (diffDays === 0) relText = "Today";
              else if (diffDays === 1) relText = "Tomorrow";
              else relText = `in ${diffDays}d`;
              // Use window global regional formatting or fallback
              let fmtDate = dueDate.toLocaleDateString();
              const df = window.mSettings?.dateFormat;
              if (df === "absolute-iso") {
                fmtDate = dueVal.split("T")[0] ?? dueVal;
              } else if (df === "absolute-eu") {
                fmtDate = `${String(dueDate.getDate()).padStart(2, "0")}/${String(dueDate.getMonth() + 1).padStart(2, "0")}/${dueDate.getFullYear()}`;
              } else if (df === "absolute-us") {
                fmtDate = `${String(dueDate.getMonth() + 1).padStart(2, "0")}/${String(dueDate.getDate()).padStart(2, "0")}/${dueDate.getFullYear()}`;
              }

              if (df === "relative") {
                dueDisplay.textContent = relText;
              } else {
                dueDisplay.textContent = `${fmtDate} (${relText})`;
              }
              dueDisplay.style.color =
                diffDays < 0
                  ? "var(--danger)"
                  : diffDays <= 3
                    ? "var(--warning)"
                    : "var(--text-muted)";
              dueRow.classList.remove("hidden");
            } else if (dueRow) {
              dueRow.classList.add("hidden");
            }

            (document.getElementById("td-color") as HTMLInputElement).value =
              String(t.color ?? "#6366F1");
            (document.getElementById("td-due-date") as HTMLInputElement).value =
              String(t.due_date ?? "");
            (
              document.getElementById("td-start-date") as HTMLInputElement
            ).value = String(t.start_date ?? "");
            (document.getElementById("td-end-date") as HTMLInputElement).value =
              String(t.end_date ?? "");
            (
              document.getElementById("td-time-tracked") as HTMLInputElement
            ).value = String(t.time_tracked ?? 0);
            // Populate board dropdown
            const boardSelect = document.getElementById(
              "td-board",
            ) as HTMLSelectElement;
            const currentBoardId = String(t.board_id ?? "default");
            try {
              const boardRes = await fetch(
                (window.__ingress_path || "") + "/api/boards",
              );
              if (boardRes.ok) {
                const boardData = await boardRes.json();
                const boards = boardData.boards ?? [];
                boardSelect.innerHTML = "";
                boards.forEach(
                  (b: { id: string; title: string; icon: string }) => {
                    const opt = document.createElement("option");
                    opt.value = b.id;
                    opt.textContent = `${b.icon} ${b.title}`;
                    boardSelect.appendChild(opt);
                  },
                );
                boardSelect.value = currentBoardId;
              }
            } catch {
              boardSelect.innerHTML = `<option value="${currentBoardId}">${currentBoardId}</option>`;
            }
            // Phase 20: Agile hierarchy type
            (
              document.getElementById("td-task-type") as HTMLSelectElement
            ).value = String(t.task_type ?? "task");

            // Phase 1 (REC-04): Set recurrence select to current value
            const recurrenceSelect = document.getElementById("td-recurrence") as HTMLSelectElement | null;
            if (recurrenceSelect) {
              recurrenceSelect.value = String(t.recurrence_rule ?? "");
              const descEl = document.getElementById("td-recurrence-desc");
              if (descEl) {
                descEl.textContent = t.recurrence_rule
                  ? `🔁 ${recurrenceSelect.selectedOptions[0]?.textContent ?? ""}`
                  : "";
              }
            }

            // Assigned To — populate from /api/users
            const assignSelect = document.getElementById(
              "td-assigned-to",
            ) as HTMLSelectElement | null;
            if (assignSelect) {
              try {
                const usersRes = await fetch(
                  (window.__ingress_path || "") + "/api/users",
                );
                if (usersRes.ok) {
                  const usersData = await usersRes.json();
                  const users = usersData.users ?? [];
                  assignSelect.innerHTML =
                    '<option value="">Unassigned</option>';
                  for (const u of users) {
                    const opt = document.createElement("option");
                    opt.value = u.id;
                    opt.textContent = u.display_name ?? u.name ?? u.id;
                    assignSelect.appendChild(opt);
                  }
                }
              } catch {
                /* keep default unassigned option */
              }
              assignSelect.value = String(t.assigned_to ?? "");
            }

            const isFav = Number(t.is_favorite ?? 0);
            const favBtn = document.getElementById("td-fav-btn");
            if (favBtn)
              favBtn.textContent = isFav
                ? "★ Favorited"
                : "⭐ Add to Favorites";
            const isDone = String(t.status) === "complete";
            const tdToggleDone = document.getElementById("td-toggle-done");
            if (tdToggleDone)
              tdToggleDone.textContent = isDone
                ? "↩ Mark as Undone"
                : "✓ Mark as Done";

            // Load settings-defined custom fields
            _settingsFields = [];
            let allSettings: Record<string, unknown> = {};
            try {
              const settingsRes = await fetch(
                (window.__ingress_path || "") + "/api/settings",
              );
              if (settingsRes.ok) {
                allSettings = await settingsRes.json();
                if (allSettings?.custom_fields) {
                  try {
                    const parsed = JSON.parse(
                      allSettings.custom_fields as string,
                    );
                    if (Array.isArray(parsed)) _settingsFields = parsed;
                  } catch {
                    /* malformed custom_fields JSON — use defaults */
                  }
                }
              }
            } catch { /* non-fatal */ }

            // Attach Strategic Lens Evaluator Payload Hook
            if (window.attachStrategicLens) {
              window.attachStrategicLens(
                taskId,
                String(t.task_type ?? "task"),
                String(t.framework_payload ?? "{}"),
                allSettings,
              );
            }

            // Labels (interactive chips)
            const labelsDiv = document.getElementById(
              "td-labels",
            ) as HTMLElement;
            labelsDiv.innerHTML = "";
            currentLabels = [];
            try {
              const labels = JSON.parse(String(t.labels ?? "[]"));
              if (Array.isArray(labels)) {
                currentLabels = labels.map((l: string | { name: string }) =>
                  typeof l === "string" ? l : l.name,
                );
                currentLabels.forEach((lbl) => addLabelChip(lbl));
              }
            } catch {
              /* skip */
            }

            // Custom fields (interactive rows)
            const cfDiv = document.getElementById(
              "td-custom-fields",
            ) as HTMLElement;
            cfDiv.innerHTML = "";
            const renderedKeys = new Set<string>();
            try {
              const cf = JSON.parse(String(t.custom_fields ?? "{}")) as Record<
                string,
                string
              >;
              for (const [k, v] of Object.entries(cf)) {
                if (v !== null && v !== undefined) {
                  const sfDef = _settingsFields.find(
                    (sf: { name: string }) => sf.name === k,
                  );
                  addCFRow(k, String(v), sfDef?.type || "text", sfDef?.options);
                  renderedKeys.add(k);
                }
              }
            } catch {
              /* skip */
            }

            // Pre-populate settings-defined fields that aren't already on this task
            for (const sf of _settingsFields) {
              if (!renderedKeys.has(sf.name) && !RICE_KEYS.includes(sf.name)) {
                addCFRow(
                  sf.name,
                  sf.type === "checkbox" ? "false" : "",
                  sf.type || "text",
                  sf.options,
                );
                renderedKeys.add(sf.name);
              }
            }

            // Framework fields are no longer rendered as plain text custom fields

            // Timestamps
            const created = t.created_at
              ? new Date(Number(t.created_at)).toLocaleDateString()
              : "";
            const updated = t.updated_at
              ? new Date(Number(t.updated_at)).toLocaleDateString()
              : "";
            const tdUpdated = document.getElementById("td-updated");
            if (tdUpdated)
              tdUpdated.textContent =
                "Last updated " +
                new Date(Number(t.updated_at)).toLocaleString();
            const checklistsContainer = document.getElementById(
              "td-checklists",
            ) as HTMLElement;
            const clDoneSpan = document.getElementById(
              "td-checklist-done",
            ) as HTMLElement;
            const clTotalSpan = document.getElementById(
              "td-checklist-total",
            ) as HTMLElement;
            const clProgressDiv = document.getElementById(
              "td-checklist-progress",
            ) as HTMLElement;

            window.__currentChecklists = [];
            try {
              if (t.checklists) {
                window.__currentChecklists =
                  typeof t.checklists === "string"
                    ? JSON.parse(String(t.checklists))
                    : t.checklists;
              }
            } catch {
              /* skip */
            }

            window.refreshChecklistsVisuals = () => {
              const list = window.__currentChecklists || [];
              if (checklistsContainer) {
                checklistsContainer.innerHTML = "";
                let doneCount = 0;
                list.forEach((item: any, index: number) => {
                  if (item.done) doneCount++;
                  const row = document.createElement("div");
                  row.className = "flex items-center gap-2 group";
                  row.innerHTML = `
                    <input type="checkbox" class="form-checkbox h-4 w-4 bg-transparent border-border rounded" ${item.done ? "checked" : ""} />
                    <input type="text" class="form-input flex-1 text-sm bg-transparent border-transparent px-1 py-0.5 focus:bg-(--bg-input) focus:border-(--border-focus) hover:bg-(--bg-hover)" value="${item.text.replace(/"/g, "&quot;")}" placeholder="Checklist item..." />
                    <button type="button" class="text-danger opacity-0 group-hover:opacity-100 transition-opacity text-xs p-1" title="Delete item">×</button>
                  `;
                  // Toggle done
                  const cb = row.querySelector(
                    "input[type=checkbox]",
                  ) as HTMLInputElement;
                  cb.addEventListener("change", () => {
                    if (list[index]) {
                      list[index].done = cb.checked;
                      saveTD("checklists", JSON.stringify(list));
                      window.refreshChecklistsVisuals?.();
                    }
                  });
                  // Edit text
                  const txt = row.querySelector(
                    "input[type=text]",
                  ) as HTMLInputElement;
                  txt.addEventListener("blur", () => {
                    if (list[index] && txt.value.trim() !== list[index].text) {
                      list[index].text = txt.value.trim();
                      saveTD("checklists", JSON.stringify(list));
                    }
                  });
                  txt.addEventListener("keydown", (e: KeyboardEvent) => {
                    if (e.key === "Enter") txt.blur();
                  });
                  // Delete
                  const del = row.querySelector("button") as HTMLButtonElement;
                  del.addEventListener("click", () => {
                    list.splice(index, 1);
                    saveTD("checklists", JSON.stringify(list));
                    window.refreshChecklistsVisuals?.();
                  });
                  checklistsContainer.appendChild(row);
                });

                if (clProgressDiv && clDoneSpan && clTotalSpan) {
                  if (list.length > 0) {
                    clProgressDiv.style.display = "block";
                    clDoneSpan.textContent = String(doneCount);
                    clTotalSpan.textContent = String(list.length);
                  } else {
                    clProgressDiv.style.display = "none";
                  }
                }
              }
            };
            window.refreshChecklistsVisuals();

            // Load comments
            loadComments(taskId);

            // Load attachments (Phase 23)
            loadAttachments(taskId);
            // Delay resetting _isPopulating so blur/change events that
            // fire asynchronously during focus transitions don't trigger
            // spurious save notifications
            setTimeout(() => { _isPopulating = false }, 100);
          } catch (e) {
            console.error("Failed to load task detail", e);
            _isPopulating = false;
            closeTD()
          }
        }

        async function loadComments(taskId: string) {
          const container = document.getElementById(
            "td-comments",
          ) as HTMLElement;
          try {
            const res = await fetch(
              `${window.__ingress_path || ""}/api/tasks/${taskId}/comments`,
            );
            const data = (await res.json()) as {
              comments: Array<{
                content: string;
                author: string;
                created_at: string;
              }>;
            };
            container.innerHTML = "";
            for (const c of data.comments || []) {
              const wrapper = document.createElement("div");
              wrapper.className =
                "bg-bg-card rounded-md p-3 border border-border";

              const meta = document.createElement("div");
              meta.className =
                "flex justify-between text-xs text-text-muted mb-1";
              const authorSpan = document.createElement("span");
              authorSpan.textContent = c.author;
              const dateSpan = document.createElement("span");
              dateSpan.textContent = new Date(c.created_at).toLocaleString();
              meta.appendChild(authorSpan);
              meta.appendChild(dateSpan);

              const body = document.createElement("div");
              body.className = "text-sm text-text-primary";
              body.textContent = c.content;

              wrapper.appendChild(meta);
              wrapper.appendChild(body);
              container.appendChild(wrapper);
            }
          } catch {
            container.innerHTML = "";
          }
        }

        // Phase 23 Attachments Loader
        async function loadAttachments(taskId: string) {
          const container = document.getElementById(
            "td-attachments",
          ) as HTMLElement;
          if (!container) return;
          container.innerHTML = "";

          try {
            const attachments = await getAttachmentsByTaskId(taskId);
            if (attachments.length === 0) {
              container.innerHTML =
                '<span class="text-[10px] text-text-muted italic">No attachments.</span>';
              return;
            }

            attachments.forEach((att) => {
              const thumb = document.createElement("div");
              thumb.className =
                "relative group cursor-pointer border border-border rounded-md overflow-hidden hover:border-accent transition-colors";
              thumb.style.width = "64px";
              thumb.style.height = "64px";

              const img = document.createElement("img");
              img.src = att.base64Data;
              img.className = "w-full h-full object-cover";
              img.title = att.filename;

              // Delete overlay
              const delOverlay = document.createElement("div");
              delOverlay.className =
                "absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity";
              const delBtn = document.createElement("button");
              delBtn.className = "text-white text-xs hover:text-danger p-2";
              delBtn.innerHTML = "🗑";
              delBtn.onclick = async (e) => {
                e.stopPropagation();
                const ok = await confirmDialog({
                  message: "Delete this attachment?",
                  variant: "danger",
                  confirmText: "Delete",
                  title: "Delete Attachment",
                });
                if (ok) {
                  await deleteAttachment(att.id);
                  loadAttachments(taskId);
                }
              };
              delOverlay.appendChild(delBtn);

              // Lightbox view on click
              thumb.onclick = () => {
                const html = `<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;"><img src="${att.base64Data}" style="max-width:100%;max-height:100vh;" /></body></html>`;
                const blob = new Blob([html], { type: "text/html" });
                window.open(URL.createObjectURL(blob), "_blank");
              };

              thumb.appendChild(img);
              thumb.appendChild(delOverlay);
              container.appendChild(thumb);
            });
          } catch (e) {
            console.error("Failed to load attachments", e);
            container.innerHTML =
              '<span class="text-xs text-danger">Failed to load attachments</span>';
          }
        }

        async function saveTD(field: string, value: unknown) {
          if (!currentTaskId || _isPopulating) return;
          try {
            const res = await fetch(
              `${window.__ingress_path || ""}/api/tasks/${currentTaskId}`,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ [field]: value }),
              },
            );
            if (res.ok) {
              const notif = document.getElementById("save-notification");
              if (notif) {
                notif.style.transform = "translateY(0)";
                notif.style.opacity = "1";
                setTimeout(() => {
                  notif.style.transform = "translateY(100%)";
                  notif.style.opacity = "0";
                }, 2000);
              }
            } else {
              console.warn(`[saveTD] Failed to save ${field}:`, res.status);
            }
          } catch (err) {
            console.warn(`[saveTD] Network error saving ${field}:`, err);
          }
        }

        // Markdown Editor Toggle Logic
        const descEditBtn = document.getElementById("td-desc-edit-btn");
        const descPreviewBtn = document.getElementById("td-desc-preview-btn");
        const descEditContainer = document.getElementById(
          "td-desc-edit-container",
        );
        const descPreviewContainer = document.getElementById(
          "td-desc-preview-container",
        );
        const descPreview = document.getElementById("td-desc-preview");
        const tdDescription = document.getElementById(
          "td-description",
        ) as HTMLTextAreaElement;

        const activeClasses = ["bg-bg-tertiary", "text-text-primary", "shadow-sm"];
        const inactiveClasses = ["text-text-muted", "hover:bg-bg-tertiary/50", "hover:text-text-primary"];

        descEditBtn?.addEventListener("click", () => {
          descEditContainer?.classList.remove("hidden");
          descPreviewContainer?.classList.add("hidden");
          
          descEditBtn.classList.remove(...inactiveClasses);
          descEditBtn.classList.add(...activeClasses);
          
          descPreviewBtn?.classList.remove(...activeClasses);
          descPreviewBtn?.classList.add(...inactiveClasses);
          
          tdDescription?.focus();
        });

        descPreviewBtn?.addEventListener("click", () => {
          descEditContainer?.classList.add("hidden");
          descPreviewContainer?.classList.remove("hidden");
          
          descPreviewBtn.classList.remove(...inactiveClasses);
          descPreviewBtn.classList.add(...activeClasses);
          
          descEditBtn?.classList.remove(...activeClasses);
          descEditBtn?.classList.add(...inactiveClasses);

          if (descPreview && tdDescription) {
            const rawMarkdown = tdDescription.value;
            try {
              // Parse markdown synchronously and sanitize
              const dirtyHtml = marked.parse(
                rawMarkdown || "*No description provided.*",
              ) as string;
              descPreview.innerHTML = sanitizeClient(dirtyHtml);
            } catch (e: any) {
              console.error("Markdown render error:", e);
              descPreview.innerHTML = `<div class="text-red-500">Error rendering markdown: ${e.message}</div>`;
            }
          }
        });

        // Auto-save on change
        const tdTitleInput = document.getElementById("td-title") as HTMLTextAreaElement;
        if (tdTitleInput) {
          tdTitleInput.addEventListener("blur", (e) =>
            saveTD("title", (e.target as HTMLTextAreaElement).value),
          );
          tdTitleInput.addEventListener("input", function() {
            this.style.height = "auto";
            this.style.height = this.scrollHeight + "px";
          });
        }
        document
          .getElementById("td-title")
          ?.addEventListener("blur", (e) =>
            saveTD("title", (e.target as HTMLInputElement).value),
          );
        document
          .getElementById("td-description")
          ?.addEventListener("blur", (e) =>
            saveTD("description", (e.target as HTMLTextAreaElement).value),
          );

        // Phase 23: Image attachments upload
        document
          .getElementById("td-attachment-input")
          ?.addEventListener("change", async (e) => {
            if (!currentTaskId) return;
            const input = e.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;

            // Convert to Base64
            const reader = new FileReader();
            reader.onload = async (re) => {
              const base64Data = String(re.target?.result);
              try {
                await saveAttachment({
                  id: crypto.randomUUID(),
                  taskId: currentTaskId!,
                  filename: file.name,
                  mimeType: file.type,
                  base64Data,
                  createdAt: new Date().toISOString(),
                });
                loadAttachments(currentTaskId!);
              } catch (err) {
                console.error("Failed to save attachment", err);
                const { showToast } = await import("@lib/toast");
                showToast(
                  "Failed to save attachment due to storage limits or error.",
                  "error",
                );
              }
            };
            reader.readAsDataURL(file);

            // Reset input so the same file can be selected again
            input.value = "";
          });

        // Global Add Checklist Item handler
        document
          .getElementById("td-add-checklist-item")
          ?.addEventListener("click", () => {
            if (!currentTaskId) return;
            const list = window.__currentChecklists || [];
            list.push({
              id: crypto.randomUUID(),
              text: "New Item",
              done: false,
            });
            window.__currentChecklists = list;
            saveTD("checklists", JSON.stringify(list)).then(() => {
              if (typeof window.refreshChecklistsVisuals === "function") {
                window.refreshChecklistsVisuals();
                // focus the newly added input
                const container = document.getElementById("td-checklists");
                if (container) {
                  const inputs = container.querySelectorAll("input[type=text]");
                  if (inputs.length > 0) {
                    (inputs[inputs.length - 1] as HTMLElement).focus();
                    (inputs[inputs.length - 1] as HTMLInputElement).select();
                  }
                }
              }
            });
          });

          document.getElementById("td-status")
          ?.addEventListener("change", (e) => {
            const newVal = (e.target as HTMLSelectElement).value;
            saveTD("status", newVal);
            const isDone = newVal === "complete";
            if (isDone) {
              const pri = Number((document.getElementById("td-priority") as HTMLSelectElement)?.value ?? 3);
              onTaskCompleted(pri);
            }
            const doneBtn = document.getElementById("td-toggle-done");
            if (doneBtn)
              doneBtn.textContent = isDone
                ? "↩ Mark as Undone"
                : "✓ Mark as Done";
          });
        document
          .getElementById("td-priority")
          ?.addEventListener("change", (e) =>
            saveTD("priority", Number((e.target as HTMLSelectElement).value)),
          );
        // Phase 20: task_type auto-save
        document
          .getElementById("td-task-type")
          ?.addEventListener("change", (e) => {
            saveTD("task_type", (e.target as HTMLSelectElement).value);
          });
        // Phase 26: board change auto-save
        document.getElementById("td-board")?.addEventListener("change", (e) => {
          saveTD("board_id", (e.target as HTMLSelectElement).value);
        });
        // Assigned To: auto-save on change + toast feedback (UX2)
        document
          .getElementById("td-assigned-to")
          ?.addEventListener("change", async (e) => {
            const val = (e.target as HTMLSelectElement).value || null;
            saveTD("assigned_to", val);
            const sel = e.target as HTMLSelectElement;
            const label = val
              ? (sel.options[sel.selectedIndex]?.textContent ?? val)
              : "Unassigned";
            const { showToast } = await import("@lib/toast");
            showToast(val ? `Assigned to ${label}` : "Unassigned");
          });
        // UX2: Keyboard shortcut 'A' to focus assignee dropdown in detail panel
        document.addEventListener("keydown", (e) => {
          const panel = document.getElementById("task-detail-panel");
          if (!panel || panel.style.display === "none") return;
          if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const active = document.activeElement as HTMLElement;
            if (
              active?.tagName === "INPUT" ||
              active?.tagName === "TEXTAREA" ||
              active?.tagName === "SELECT" ||
              active?.isContentEditable
            )
              return;
            e.preventDefault();
            document.getElementById("td-assigned-to")?.focus();
          }
        });
        document
          .getElementById("td-progress")
          ?.addEventListener("input", (e) => {
            const v = (e.target as HTMLInputElement).value;
            const progEl = document.getElementById("td-progress-value");
            if (progEl) progEl.textContent = `${v}%`;
          });
        document
          .getElementById("td-progress")
          ?.addEventListener("change", (e) =>
            saveTD("progress", Number((e.target as HTMLInputElement).value)),
          );
        document
          .getElementById("td-color")
          ?.addEventListener("change", (e) =>
            saveTD("color", (e.target as HTMLInputElement).value),
          );
        document
          .getElementById("td-due-date")
          ?.addEventListener("change", (e) =>
            saveTD("due_date", (e.target as HTMLInputElement).value || null),
          );
        document
          .getElementById("td-start-date")
          ?.addEventListener("change", (e) =>
            saveTD("start_date", (e.target as HTMLInputElement).value || null),
          );
        document
          .getElementById("td-end-date")
          ?.addEventListener("change", (e) =>
            saveTD("end_date", (e.target as HTMLInputElement).value || null),
          );
        document
          .getElementById("td-time-tracked")
          ?.addEventListener("change", (e) =>
            saveTD(
              "time_tracked",
              Number((e.target as HTMLInputElement).value) || 0,
            ),
          );

        // ───── Labels interactive ─────

        // Phase 1 (REC-04): Recurrence select → save on change
        document
          .getElementById("td-recurrence")
          ?.addEventListener("change", (e) => {
            const val = (e.target as HTMLSelectElement).value || null;
            saveTD("recurrence_rule", val);
            const descEl = document.getElementById("td-recurrence-desc");
            if (descEl) {
              descEl.textContent = val ? `🔁 ${(e.target as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""}` : "";
            }
          });

        // Phase 1 (SUB-02): Add subtask inline form
        const addSubBtn = document.getElementById("td-add-subtask-btn");
        const addSubForm = document.getElementById("td-add-subtask-form");
        const addSubInput = document.getElementById("td-add-subtask-input") as HTMLInputElement | null;
        const addSubSubmit = document.getElementById("td-add-subtask-submit");
        const addSubCancel = document.getElementById("td-add-subtask-cancel");

        if (addSubBtn && addSubForm && addSubInput && addSubSubmit && addSubCancel) {
          addSubBtn.addEventListener("click", () => {
            addSubForm.classList.remove("hidden");
            addSubForm.classList.add("flex");
            addSubBtn.classList.add("hidden");
            addSubInput.value = "";
            addSubInput.focus();
          });
          addSubCancel.addEventListener("click", () => {
            addSubForm.classList.add("hidden");
            addSubForm.classList.remove("flex");
            addSubBtn.classList.remove("hidden");
          });
          const submitSubtask = async () => {
            const title = addSubInput.value.trim();
            if (!title) return;
            addSubInput.disabled = true;
            try {
              const parentBoardEl = document.getElementById("td-board") as HTMLSelectElement | null;
              const parentTypeEl = document.getElementById("td-task-type") as HTMLSelectElement | null;
              const parentType = parentTypeEl?.value ?? "task";
              const childType = parentType === "epic" ? "story" : "task";
              const res = await fetch(`${window.__ingress_path || ""}/api/tasks`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  title,
                  parent_id: currentTaskId,
                  board_id: parentBoardEl?.value ?? "default",
                  task_type: childType,
                  status: "pending",
                }),
              });
              if (res.ok) {
                addSubInput.value = "";
                addSubForm.classList.add("hidden");
                addSubBtn.classList.remove("hidden");
                openTaskDetail(String(currentTaskId));
                const { showToast } = await import("@lib/toast");
                showToast(`Subtask "${title}" created`);
              } else {
                const err = await res.json().catch(() => ({ error: "Failed to create subtask" }));
                const { showToast } = await import("@lib/toast");
                showToast(err.error ?? "Failed to create subtask", "error");
              }
            } catch {
              const { showToast } = await import("@lib/toast");
              showToast("Network error creating subtask", "error");
            } finally {
              addSubInput.disabled = false;
            }
          };
          addSubSubmit.addEventListener("click", submitSubtask);
          addSubInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") submitSubtask();
            if (e.key === "Escape") {
              addSubForm.classList.add("hidden");
              addSubBtn.classList.remove("hidden");
            }
          });
        }

        // ───── Labels interactive ─────
        let currentLabels: string[] = [];

        function addLabelChip(label: string) {
          const labelsDiv = document.getElementById("td-labels") as HTMLElement;
          const chip = document.createElement("span");
          chip.className = "label-chip";
          chip.style.cssText =
            "cursor:pointer;display:inline-flex;align-items:center;gap:4px;";
          // Use textContent to prevent XSS from user-provided label values
          const labelText = document.createTextNode(label);
          chip.appendChild(labelText);
          const removeBtn = document.createElement("span");
          removeBtn.className = "td-label-remove";
          removeBtn.style.cssText = "font-size:14px;line-height:1;opacity:0.6;";
          removeBtn.textContent = "×";
          removeBtn.addEventListener("click", () => {
              currentLabels = currentLabels.filter((l) => l !== label);
              chip.remove();
              saveTD("labels", JSON.stringify(currentLabels));
            });
          chip.appendChild(removeBtn);
          labelsDiv.appendChild(chip);
        }

        document
          .getElementById("td-label-input")
          ?.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const input = e.target as HTMLInputElement;
            const val = input.value.trim();
            if (!val || currentLabels.includes(val)) {
              input.value = "";
              return;
            }
            currentLabels.push(val);
            addLabelChip(val);
            input.value = "";
            saveTD("labels", JSON.stringify(currentLabels));
          });

        // ───── Custom Fields interactive ─────

        function getCFFromUI(): Record<string, string> {
          const result: Record<string, string> = {};
          document.querySelectorAll(".td-cf-row").forEach((row) => {
            const key = (
              row.querySelector(".td-cf-key") as HTMLInputElement
            )?.value.trim();
            // Handle checkbox vs other input types
            const cbInput = row.querySelector(
              "input[type=checkbox].td-cf-val",
            ) as HTMLInputElement | null;
            const otherInput = row.querySelector(
              "select.td-cf-val, input:not([type=checkbox]).td-cf-val",
            ) as HTMLInputElement | HTMLSelectElement | null;
            let val = "";
            if (cbInput) {
              val = cbInput.checked ? "true" : "false";
            } else if (otherInput) {
              val = otherInput.value.trim();
            }
            if (key) result[key] = val;
          });
          return result;
        }

        let _saveCFTimer: ReturnType<typeof setTimeout> | null = null;

        function saveCF() {
          // Debounce the actual API save
          if (_saveCFTimer) clearTimeout(_saveCFTimer);
          _saveCFTimer = setTimeout(() => {
            const all = getCFFromUI();
            saveTD("custom_fields", JSON.stringify(all));
          }, 400);
        }

        function addCFRow(
          key: string,
          value: string,
          fieldType: string = "text",
          options?: string[],
        ) {
          const cfDiv = document.getElementById(
            "td-custom-fields",
          ) as HTMLElement;
          const row = document.createElement("div");
          row.className = "td-cf-row";
          row.style.cssText = "display:flex;gap:6px;align-items:center;";

          // Key label (always a readonly text input for consistency)
          let valueHtml = "";
          if (fieldType === "checkbox") {
            const isChecked =
              value === "true" || value === "1" || value === "yes";
            valueHtml = `<label class="td-cf-val-wrap" style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" class="form-checkbox td-cf-val h-5 w-5 accent-accent rounded" style="cursor:pointer;" ${isChecked ? "checked" : ""} />
              <span class="text-xs text-text-muted">${isChecked ? "Yes" : "No"}</span>
            </label>`;
          } else if (fieldType === "select" && options && options.length > 0) {
            const escapedVal = value.replace(/"/g, "&quot;");
            valueHtml = `<select class="form-input td-cf-val text-sm py-1" style="flex:1;">
              <option value=""${!value ? " selected" : ""}>Select…</option>
              ${options.map((o) => `<option value="${o.replace(/"/g, "&quot;")}"${o === value ? " selected" : ""}>${o}</option>`).join("")}
            </select>`;
          } else if (fieldType === "number") {
            valueHtml = `<input type="number" class="form-input td-cf-val text-sm py-1" placeholder="Value" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`;
          } else if (fieldType === "date") {
            valueHtml = `<input type="date" class="form-input td-cf-val text-sm py-1" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`;
          } else if (fieldType === "url") {
            valueHtml = `<input type="url" class="form-input td-cf-val text-sm py-1" placeholder="https://…" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`;
          } else {
            valueHtml = `<input type="text" class="form-input td-cf-val text-sm py-1" placeholder="Value" value="${value.replace(/"/g, "&quot;")}" style="flex:1;" />`;
          }

          row.innerHTML = `
          <input type="text" class="form-input td-cf-key text-sm py-1" placeholder="Field name" value="${key.replace(/"/g, "&quot;")}" style="flex:1;opacity:0.7;" readonly />
          ${valueHtml}
          <button type="button" class="td-cf-remove" style="color:var(--danger);font-size:16px;cursor:pointer;background:none;border:none;padding:0 4px;">&times;</button>
        `;

          // Bind save handlers based on field type
          if (fieldType === "checkbox") {
            const cb = row.querySelector(
              "input[type=checkbox]",
            ) as HTMLInputElement;
            const cbLabel = row.querySelector(
              ".td-cf-val-wrap span",
            ) as HTMLElement;
            cb?.addEventListener("change", () => {
              if (cbLabel) cbLabel.textContent = cb.checked ? "Yes" : "No";
              saveCF();
            });
          } else {
            const valInput = row.querySelector(".td-cf-val")!;
            valInput.addEventListener("blur", saveCF);
            valInput.addEventListener("input", saveCF);
          }

          row.querySelector(".td-cf-remove")!.addEventListener("click", () => {
            row.remove();
            saveCF();
          });
          cfDiv.appendChild(row);
        }

        // Categorized field groups for the dropdown
        const fieldCategories: { label: string; fields: string[] }[] = [
          {
            label: "🎯 RICE Framework",
            fields: ["Reach", "Impact", "Confidence", "Effort"],
          },
          {
            label: "📋 Agile & Planning",
            fields: [
              "Estimate",
              "Sprint",
              "Team",
              "Component",
              "Environment",
              "Version",
              "Story Points",
              "Acceptance Criteria",
            ],
          },
          {
            label: "📊 Sizing & Value",
            fields: ["Complexity", "T-Shirt Size", "Business Value"],
          },
        ];

        function getAvailableFields(): { label: string; fields: string[] }[] {
          const currentKeys = new Set(Object.keys(getCFFromUI()));
          // Build categorized list filtered by what's already on the task
          const result = fieldCategories
            .map((cat) => ({
              label: cat.label,
              fields: cat.fields.filter((f) => !currentKeys.has(f)),
            }))
            .filter((cat) => cat.fields.length > 0);
          // Inject settings-defined fields not already present
          if (_settingsFields.length > 0) {
            const allPredefinedNames = new Set(
              fieldCategories.flatMap((c) => c.fields),
            );
            const settingsOnly = _settingsFields
              .map((sf) => sf.name)
              .filter((n) => !currentKeys.has(n) && !allPredefinedNames.has(n));
            if (settingsOnly.length > 0) {
              result.unshift({
                label: "📋 Settings Fields",
                fields: settingsOnly,
              });
            }
          }
          // Add any custom keys from existing rows not in our predefined lists
          const allPredefined = new Set(
            fieldCategories.flatMap((c) => c.fields),
          );
          const existingCustom: string[] = [];
          document.querySelectorAll(".td-cf-key").forEach((el) => {
            const val = (el as HTMLInputElement).value.trim();
            if (val && !allPredefined.has(val) && !currentKeys.has(val))
              existingCustom.push(val);
          });
          if (existingCustom.length > 0) {
            result.push({
              label: "🔧 Custom",
              fields: [...new Set(existingCustom)].sort(),
            });
          }
          return result;
        }

        function renderFieldDropdown(filter = "") {
          const optionsDiv = document.getElementById("td-add-cf-options")!;
          const lowerFilter = filter.toLowerCase();
          const categories = getAvailableFields();
          let html = "";
          let totalCount = 0;
          for (const cat of categories) {
            const filtered = cat.fields.filter((f) =>
              f.toLowerCase().includes(lowerFilter),
            );
            if (filtered.length === 0) continue;
            totalCount += filtered.length;
            html += `<div class="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wide font-semibold border-t border-border first:border-t-0">${cat.label}</div>`;
            html += filtered
              .map((f) => {
                const sfDef = _settingsFields.find((sf) => sf.name === f);
                const typeBadge: Record<string, string> = {
                  text: "📝",
                  checkbox: "☑️",
                  select: "📊",
                  date: "📅",
                  number: "🔢",
                  url: "🔗",
                };
                const badge = typeBadge[sfDef?.type || "text"] || "📝";
                return `<div class="td-cf-option px-3 py-1.5 text-sm cursor-pointer hover:bg-bg-hover" data-field="${f.replace(/"/g, "&quot;")}">${badge} ${f}</div>`;
              })
              .join("");
          }
          optionsDiv.innerHTML =
            totalCount > 0
              ? html
              : `<div class="px-3 py-1.5 text-xs text-text-muted italic">Type a custom name and press Enter</div>`;
          // Click handlers
          optionsDiv.querySelectorAll(".td-cf-option").forEach((opt) => {
            opt.addEventListener("click", () => {
              const fieldName = (opt as HTMLElement).dataset.field || "";
              const sfDef = _settingsFields.find(
                (sf: { name: string }) => sf.name === fieldName,
              );
              addCFRow(
                fieldName,
                sfDef?.type === "checkbox" ? "false" : "",
                sfDef?.type || "text",
                sfDef?.options,
              );
              document.getElementById("td-add-cf-dropdown")!.style.display =
                "none";
              (
                document.getElementById("td-add-cf-search") as HTMLInputElement
              ).value = "";
            });
          });
        }

        document.getElementById("td-add-cf")?.addEventListener("click", (e) => {
          e.stopPropagation();
          const dropdown = document.getElementById("td-add-cf-dropdown")!;
          const isVisible = dropdown.style.display !== "none";
          dropdown.style.display = isVisible ? "none" : "block";
          if (!isVisible) {
            renderFieldDropdown();
            (
              document.getElementById("td-add-cf-search") as HTMLInputElement
            ).focus();
          }
        });

        document
          .getElementById("td-add-cf-search")
          ?.addEventListener("input", (e) => {
            renderFieldDropdown((e.target as HTMLInputElement).value);
          });

        document
          .getElementById("td-add-cf-search")
          ?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const input = e.target as HTMLInputElement;
              const val = input.value.trim();
              if (val) {
                const sfDef = _settingsFields.find(
                  (sf: { name: string }) => sf.name === val,
                );
                addCFRow(
                  val,
                  sfDef?.type === "checkbox" ? "false" : "",
                  sfDef?.type || "text",
                  sfDef?.options,
                );
                document.getElementById("td-add-cf-dropdown")!.style.display =
                  "none";
                input.value = "";
              }
            }
            if (e.key === "Escape") {
              document.getElementById("td-add-cf-dropdown")!.style.display =
                "none";
            }
          });

        // Close dropdown on outside click
        document.addEventListener("click", (e) => {
          if (
            !(e.target as Element)?.closest("#td-add-cf-dropdown") &&
            !(e.target as Element)?.closest("#td-add-cf")
          ) {
            const dd = document.getElementById("td-add-cf-dropdown");
            if (dd) dd.style.display = "none";
          }
          // Also close parent search results
          if (
            !(e.target as Element)?.closest("#td-link-parent-search") &&
            !(e.target as Element)?.closest("#td-link-parent-results")
          ) {
            const pr = document.getElementById("td-link-parent-results");
            if (pr) pr.style.display = "none";
          }
        });

        // Parent search — debounced type-ahead
        let parentSearchTimer: ReturnType<typeof setTimeout>;
        const parentSearchInput = document.getElementById(
          "td-link-parent-search",
        ) as HTMLInputElement | null;
        const parentResultsDiv = document.getElementById(
          "td-link-parent-results",
        );

        parentSearchInput?.addEventListener("input", () => {
          clearTimeout(parentSearchTimer);
          const q = parentSearchInput.value.trim();
          if (q.length < 2) {
            if (parentResultsDiv) parentResultsDiv.style.display = "none";
            return;
          }
          parentSearchTimer = setTimeout(async () => {
            try {
              const res = await fetch(
                `/api/tasks?q=${encodeURIComponent(q)}&limit=10`,
              );
              if (!res.ok || !parentResultsDiv) return;
              const data = await res.json();
              const tasks = (data.tasks ?? []).filter(
                (t: Record<string, unknown>) => t.id !== currentTaskId,
              );
              if (tasks.length === 0) {
                parentResultsDiv.innerHTML = `<div class="px-3 py-2 text-xs text-text-muted italic">No matches</div>`;
              } else {
                parentResultsDiv.innerHTML = tasks
                  .map((t: Record<string, unknown>) => {
                    const typeIcon =
                      t.task_type === "epic"
                        ? "🎯"
                        : t.task_type === "story"
                          ? "📖"
                          : "✅";
                    return `<div class="td-parent-result px-3 py-2 text-sm cursor-pointer hover:bg-bg-hover flex items-center gap-2" data-id="${t.id}">
                  <span>${typeIcon}</span>
                  <span class="truncate">${String(t.title).slice(0, 60)}</span>
                  <span class="text-xs text-text-muted ml-auto">${String(t.task_type ?? "task")}</span>
                </div>`;
                  })
                  .join("");
                // Click handler for each result
                parentResultsDiv
                  .querySelectorAll(".td-parent-result")
                  .forEach((el) => {
                    el.addEventListener("click", async () => {
                      const newParentId = (el as HTMLElement).dataset.id;
                      if (newParentId) {
                        await saveTD("parent_id", newParentId);
                        parentSearchInput.value = "";
                        parentResultsDiv.style.display = "none";
                        // Refresh the panel to show the new parent
                        openTaskDetail(currentTaskId!);
                      }
                    });
                  });
              }
              parentResultsDiv.style.display = "block";
            } catch {
              /* search failed silently */
            }
          }, 300);
        });

        parentSearchInput?.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && parentResultsDiv) {
            parentResultsDiv.style.display = "none";
            parentSearchInput.value = "";
          }
        });

        // ───── Related Links (Jira-style issue linking) ─────
        const LINK_TYPE_LABELS: Record<string, string> = {
          related_to: "🔗 Related to",
          blocked_by: "🚫 Blocked by",
          blocks: "⛔ Blocks",
          duplicates: "📋 Duplicates",
          duplicated_by: "📋 Duplicated by",
        };
        // Inverse labels for inbound links (when *other* task has the link pointing at *this* task)
        const INVERSE_LABELS: Record<string, string> = {
          related_to: "🔗 Related to",
          blocked_by: "⛔ Blocks",
          blocks: "🚫 Blocked by",
          duplicates: "📋 Duplicated by",
          duplicated_by: "📋 Duplicates",
        };

        async function loadRelatedLinks(taskId: string) {
          const container = document.getElementById("td-related-links");
          const countEl = document.getElementById("td-link-count");
          const liveRegion = document.getElementById("td-link-live");
          const emptyState = document.getElementById("td-links-empty");
          if (!container) return;

          // Show loading
          container.innerHTML =
            '<span class="text-xs text-text-muted italic">Loading…</span>';
          if (emptyState) emptyState.style.display = "none";

          try {
            const res = await fetch(
              `${window.__ingress_path || ""}/api/tasks/${taskId}/links`,
            );
            if (!res.ok) {
              // Error boundary (#18): show retry option
              container.innerHTML = "";
              const errDiv = document.createElement("div");
              errDiv.className =
                "text-xs text-text-muted italic py-1 cursor-pointer hover:text-accent";
              errDiv.textContent = "Failed to load links. Tap to retry.";
              errDiv.addEventListener("click", () => loadRelatedLinks(taskId));
              container.appendChild(errDiv);
              if (countEl) countEl.textContent = "";
              return;
            }
            const data = await res.json();
            const outbound = data.outbound ?? [];
            const inbound = data.inbound ?? [];
            const totalLinks = outbound.length + inbound.length;

            // Count badge (#2)
            if (countEl)
              countEl.textContent = totalLinks > 0 ? `(${totalLinks})` : "";

            if (totalLinks === 0) {
              container.innerHTML = "";
              if (emptyState) {
                emptyState.style.display = "";
                container.appendChild(emptyState);
              }
              return;
            }

            container.innerHTML = "";

            // Helper: create a link row using DOM API (XSS-safe)
            function createLinkRow(
              label: string,
              linkedTaskId: string,
              ticketKey: string,
              title: string,
              linkId: string,
            ) {
              const el = document.createElement("div");
              el.className =
                "flex items-center gap-1 text-xs py-0.5 td-link-row";
              el.style.cssText = "animation: fadeIn 0.2s ease-in;";

              const labelSpan = document.createElement("span");
              labelSpan.className = "text-text-muted";
              labelSpan.style.cssText =
                "min-width:90px;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
              labelSpan.textContent = label;

              const titleSpan = document.createElement("span");
              titleSpan.className =
                "text-accent cursor-pointer hover:underline td-link-goto truncate";
              titleSpan.dataset.id = linkedTaskId;
              titleSpan.title = "Open task";
              titleSpan.textContent =
                (ticketKey ? ticketKey + " " : "") +
                String(title || "").slice(0, 40);

              const removeBtn = document.createElement("button");
              removeBtn.type = "button";
              removeBtn.className = "td-link-remove";
              removeBtn.dataset.linkId = linkId;
              removeBtn.style.cssText =
                "color:var(--danger);font-size:14px;cursor:pointer;background:none;border:none;padding:0 2px;margin-left:auto;flex-shrink:0;";
              removeBtn.title = "Remove link";
              removeBtn.textContent = "×";
              // Accessibility (#26): descriptive aria-label
              removeBtn.setAttribute(
                "aria-label",
                `Remove ${label} link to ${String(title || "").slice(0, 30)}`,
              );

              el.appendChild(labelSpan);
              el.appendChild(titleSpan);
              el.appendChild(removeBtn);
              return el;
            }

            // Render outbound links (this task → other task)
            for (const link of outbound) {
              const label = LINK_TYPE_LABELS[link.link_type] || link.link_type;
              const ticketKey = link.target_ticket_number
                ? `MTH-${link.target_ticket_number}`
                : "";
              container.appendChild(
                createLinkRow(
                  label,
                  link.target_task_id,
                  ticketKey,
                  link.target_title,
                  link.id,
                ),
              );
            }

            // Render inbound links (other task → this task)
            for (const link of inbound) {
              const label = INVERSE_LABELS[link.link_type] || link.link_type;
              const ticketKey = link.source_ticket_number
                ? `MTH-${link.source_ticket_number}`
                : "";
              container.appendChild(
                createLinkRow(
                  label,
                  link.source_task_id,
                  ticketKey,
                  link.source_title,
                  link.id,
                ),
              );
            }

            // Navigate to linked task on click
            container.querySelectorAll(".td-link-goto").forEach((el) => {
              el.addEventListener("click", () => {
                const tid = (el as HTMLElement).dataset.id;
                if (tid) openTaskDetail(tid);
              });
            });

            // Remove link on click — captures taskId in closure (#20 race guard)
            const capturedTaskId = taskId;
            container.querySelectorAll(".td-link-remove").forEach((btn) => {
              btn.addEventListener("click", async () => {
                const linkId = (btn as HTMLElement).dataset.linkId;
                if (!linkId) return;
                try {
                  await fetch(
                    `${window.__ingress_path || ""}/api/tasks/${capturedTaskId}/links?link_id=${encodeURIComponent(linkId)}`,
                    { method: "DELETE" },
                  );
                  // ARIA announcement (#30)
                  if (liveRegion) liveRegion.textContent = "Link removed";
                  loadRelatedLinks(capturedTaskId);
                } catch {
                  if (liveRegion)
                    liveRegion.textContent = "Failed to remove link";
                }
              });
            });
          } catch {
            // Error boundary (#18)
            container.innerHTML = "";
            const errDiv = document.createElement("div");
            errDiv.className =
              "text-xs text-text-muted italic py-1 cursor-pointer hover:text-accent";
            errDiv.textContent = "Failed to load links. Tap to retry.";
            errDiv.addEventListener("click", () => loadRelatedLinks(taskId));
            container.appendChild(errDiv);
            if (countEl) countEl.textContent = "";
          }
        }

        // Related link search — debounced
        let linkSearchTimer: ReturnType<typeof setTimeout>;
        const linkSearchInput = document.getElementById(
          "td-link-search",
        ) as HTMLInputElement | null;
        const linkSearchResults = document.getElementById(
          "td-link-search-results",
        );

        linkSearchInput?.addEventListener("input", () => {
          clearTimeout(linkSearchTimer);
          const q = linkSearchInput.value.trim();
          if (q.length < 2) {
            if (linkSearchResults) linkSearchResults.style.display = "none";
            return;
          }
          linkSearchTimer = setTimeout(async () => {
            try {
              const res = await fetch(
                `${window.__ingress_path || ""}/api/tasks?q=${encodeURIComponent(q)}&limit=10`,
              );
              if (!res.ok || !linkSearchResults) return;
              const data = await res.json();
              const tasks = (data.tasks ?? []).filter(
                (t: Record<string, unknown>) => t.id !== currentTaskId,
              );
              if (tasks.length === 0) {
                const noMatch = document.createElement("div");
                noMatch.className = "px-3 py-2 text-xs text-text-muted italic";
                noMatch.textContent = "No matches";
                linkSearchResults.innerHTML = "";
                linkSearchResults.appendChild(noMatch);
              } else {
                linkSearchResults.innerHTML = "";
                for (const t of tasks as Record<string, unknown>[]) {
                  const typeIcon =
                    t.task_type === "epic"
                      ? "🎯"
                      : t.task_type === "story"
                        ? "📖"
                        : "✅";
                  const ticketKey = t.ticket_number
                    ? `MTH-${t.ticket_number} `
                    : "";

                  const resultEl = document.createElement("div");
                  resultEl.className =
                    "td-link-result px-3 py-1.5 text-xs cursor-pointer hover:bg-bg-hover flex items-center gap-2";
                  resultEl.dataset.id = String(t.id);
                  resultEl.setAttribute("role", "option");

                  const iconSpan = document.createElement("span");
                  iconSpan.textContent = typeIcon;

                  const titleSpan = document.createElement("span");
                  titleSpan.className = "truncate";
                  titleSpan.textContent =
                    ticketKey + String(t.title).slice(0, 50);

                  resultEl.appendChild(iconSpan);
                  resultEl.appendChild(titleSpan);
                  linkSearchResults.appendChild(resultEl);
                }
                linkSearchResults
                  .querySelectorAll(".td-link-result")
                  .forEach((el) => {
                    el.addEventListener("click", async () => {
                      const targetId = (el as HTMLElement).dataset.id;
                      const linkType =
                        (
                          document.getElementById(
                            "td-link-type-select",
                          ) as HTMLSelectElement
                        )?.value || "related_to";
                      if (targetId && currentTaskId) {
                        try {
                          await fetch(
                            `${window.__ingress_path || ""}/api/tasks/${currentTaskId}/links`,
                            {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({
                                target_task_id: targetId,
                                link_type: linkType,
                              }),
                            },
                          );
                          linkSearchInput.value = "";
                          linkSearchResults.style.display = "none";
                          linkSearchInput.setAttribute(
                            "aria-expanded",
                            "false",
                          );
                          // ARIA announcement (#30) and focus management (#29)
                          const liveRegion =
                            document.getElementById("td-link-live");
                          if (liveRegion)
                            liveRegion.textContent = "Link created";
                          linkSearchInput.focus();
                          loadRelatedLinks(currentTaskId);
                        } catch {
                          /* silent */
                        }
                      }
                    });
                  });
              }
              linkSearchResults.style.display = "block";
              linkSearchInput?.setAttribute("aria-expanded", "true");
            } catch {
              /* silent */
            }
          }, 300);
        });

        linkSearchInput?.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && linkSearchResults) {
            linkSearchResults.style.display = "none";
            linkSearchInput.value = "";
          }
        });

        // Close link search results on outside click
        document.addEventListener("click", (e) => {
          if (
            !(e.target as Element)?.closest("#td-link-search") &&
            !(e.target as Element)?.closest("#td-link-search-results")
          ) {
            if (linkSearchResults) linkSearchResults.style.display = "none";
          }
        });

        // Toggle done
        document
          .getElementById("td-toggle-done")
          ?.addEventListener("click", () => {
            const statusEl = document.getElementById(
              "td-status",
            ) as HTMLSelectElement;
            const newStatus =
              statusEl.value === "complete" ? "pending" : "complete";
            statusEl.value = newStatus;
            saveTD("status", newStatus);
            const tdDoneBtn = document.getElementById("td-toggle-done");
            if (tdDoneBtn)
              tdDoneBtn.textContent =
                newStatus === "complete"
                  ? "↩ Mark as Undone"
                  : "✓ Mark as Done";
            // Gamification + confetti on completion
            if (newStatus === "complete") {
              const priorityEl = document.getElementById("td-priority") as HTMLSelectElement | null;
              onTaskCompleted(Number(priorityEl?.value ?? 3));
            }
          });

        // Toggle favorite
        document
          .getElementById("td-toggle-favorite")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const btn = document.getElementById(
              "td-toggle-favorite",
            ) as HTMLElement;
            const isFav = btn.textContent?.startsWith("★");
            await saveTD("is_favorite", isFav ? 0 : 1);
            btn.textContent = isFav ? "⭐ Add to Favorites" : "★ Favorited";
          });

        // Duplicate task
        document
          .getElementById("td-duplicate")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const toast = document.createElement("div");
            toast.className = "toast";
            try {
              const res = await fetch(
                `${window.__ingress_path || ""}/api/tasks/${currentTaskId}/duplicate`,
                {
                  method: "POST",
                },
              );
              if (!res.ok) {
                toast.className = "toast error";
                toast.textContent = "Failed to duplicate";
                document.querySelector(".toast-container")?.appendChild(toast);
                setTimeout(() => toast.remove(), 2500);
                return;
              }
              const data = await res.json();
              toast.className = "toast success";
              toast.textContent = `Duplicated → ${data.title}`;
              document.querySelector(".toast-container")?.appendChild(toast);
              setTimeout(() => toast.remove(), 2500);
              openTaskDetail(data.id);
            } catch {
              toast.className = "toast error";
              toast.textContent = "Network error";
              document.querySelector(".toast-container")?.appendChild(toast);
              setTimeout(() => toast.remove(), 2500);
            }
          });

        // Ask AI — inline HA Assist response
        document
          .getElementById("td-ask-ai")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const btn = document.getElementById("td-ask-ai") as HTMLElement;
            const originalText = btn.innerHTML;
            btn.innerHTML = "⚙️ Thinking…";
            btn.classList.add("opacity-60", "pointer-events-none");

            // Remove previous AI response
            document.getElementById("td-ai-response")?.remove();

            try {
              const result = await askAIForTask(currentTaskId);

              const responseEl = document.createElement("div");
              responseEl.id = "td-ai-response";
              responseEl.style.cssText = "margin-top:8px;";

              if (result.source === "ha-assist" && result.response) {
                responseEl.className =
                  "p-3 bg-accent/10 border border-accent/20 rounded-md text-xs text-text-secondary leading-relaxed";
                responseEl.innerHTML = `<div class="flex justify-between items-center mb-1.5"><strong class="text-accent text-[11px]">✨ AI Response</strong><button id="td-ai-dismiss" class="text-text-muted hover:text-text-primary text-xs px-1">&times;</button></div><div class="whitespace-pre-wrap">${result.response}</div>`;
                btn.innerHTML = "✨ AI Responded";
              } else {
                responseEl.className =
                  "p-3 bg-warning/10 border border-warning/20 rounded-md text-xs text-text-secondary leading-relaxed";
                responseEl.innerHTML = `<div class="flex justify-between items-center mb-1.5"><strong class="text-warning text-[11px]">📋 Prompt Copied</strong><button id="td-ai-dismiss" class="text-text-muted hover:text-text-primary text-xs px-1">&times;</button></div><div>HA Assist unavailable. Prompt copied to clipboard — paste into your AI provider.</div>`;
                btn.innerHTML = "📋 Copied!";
              }

              // Insert after the Ask AI button
              btn.parentElement?.after(responseEl);
              responseEl
                .querySelector("#td-ai-dismiss")
                ?.addEventListener("click", () => {
                  responseEl.remove();
                });
            } catch (err) {
              console.error("AI Context error:", err);
              const { showToast: toast } = await import("@lib/toast");
              toast("Failed to generate AI context.", "error");
              btn.innerHTML = "❌ Failed";
            }

            btn.classList.remove("opacity-60", "pointer-events-none");
            setTimeout(() => (btn.innerHTML = originalText), 4000);
          });

        // Attach Image
        document
          .getElementById("td-attach-image")
          ?.addEventListener("change", async (e) => {
            if (!currentTaskId) return;
            const input = e.target as HTMLInputElement;
            const file = input.files?.[0];
            if (!file) return;

            // Convert to Base64
            const reader = new FileReader();
            reader.onload = async (evt) => {
              const base64Data = evt.target?.result as string;
              try {
                await saveAttachment({
                  id: crypto.randomUUID(),
                  taskId: currentTaskId!,
                  filename: file.name,
                  mimeType: file.type,
                  base64Data,
                  createdAt: new Date().toISOString(),
                });
                loadAttachments(currentTaskId!);
              } catch (err) {
                console.error("Attachment failed:", err);
                const { showToast: toast } = await import("@lib/toast");
                toast("Failed to save attachment.", "error");
              } finally {
                input.value = ""; // reset
              }
            };
            reader.readAsDataURL(file);
          });

        // Delete
        document
          .getElementById("td-delete")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const ok = await confirmDialog({
              message: "This task will be permanently deleted.",
              variant: "danger",
              confirmText: "Delete Task",
              title: "Delete Task",
            });
            if (!ok) return;
            try {
              const res = await fetch(
                `${window.__ingress_path || ""}/api/tasks/${currentTaskId}`,
                {
                  method: "DELETE",
                },
              );
              // Treat 204 (deleted) and 404 (already gone) as success
              if (res.ok || res.status === 404) {
                closeTD();
                window.location.reload();
              }
            } catch {
              // Network error — still close and reload to re-sync
              closeTD();
              window.location.reload();
            }
          });

        // Add comment
        document
          .getElementById("td-comment-submit")
          ?.addEventListener("click", async () => {
            const input = document.getElementById(
              "td-comment-input",
            ) as HTMLInputElement;
            if (!input.value.trim() || !currentTaskId) return;
            await fetch(
              `${window.__ingress_path || ""}/api/tasks/${currentTaskId}/comments`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: input.value.trim() }),
              },
            );
            input.value = "";
            loadComments(currentTaskId);
          });

        // Close
        document.getElementById("td-close")?.addEventListener("click", closeTD);
        tdOverlay?.addEventListener("click", (e) => {
          if (e.target === tdOverlay) closeTD();
        });

        // Hash navigation — also handles mobile back button
        function checkHash() {
          try {
            const hash = window.location.hash;
            if (hash.startsWith("#task-")) {
              openTaskDetail(hash.replace("#task-", ""));
            } else if (
              !hash &&
              currentTaskId &&
              tdOverlay &&
              !tdOverlay.classList.contains("hidden")
            ) {
              // Hash cleared (back button pressed) → close the detail panel
              tdOverlay.classList.add("hidden");
              currentTaskId = null;
            }
          } catch (err) {
            console.warn("[Meitheal] Hash navigation error:", err);
          }
        }
        window.addEventListener("hashchange", checkHash, { signal: __signal });
        checkHash();

        // Expose openTaskDetail globally for cross-page use (table, index new-task flow)
        window.openTaskDetail = openTaskDetail;

        // Delegated click → open task detail for any task element
        // P1-3: Also handles keyboard activation (Enter/Space) for a11y
        function handleTaskActivation(e: Event) {
          const target = (e as any).target as HTMLElement;
          // P1-3: For keydown events, only activate on Enter/Space
          if (e.type === "keydown") {
            const ke = e as KeyboardEvent;
            if (ke.key !== "Enter" && ke.key !== " ") return;
          }
          const taskEl = target.closest(
            ".task-item, .kanban-card, .bento-card, tr[data-id], [data-task-id]",
          ) as HTMLElement | null;
          if (!taskEl) return;
          // Don't intercept action buttons
          if (target.closest("button, a, .task-actions, .action-btn")) return;
          const taskId = taskEl.dataset.id || taskEl.dataset.taskId;
          if (taskId) {
            e.preventDefault();
            (e as Event).stopPropagation?.();
            // Clean up search dropdown if opened from search results
            if (taskEl.closest("#search-results")) {
              const sr = document.getElementById("search-results");
              const si = document.getElementById(
                "global-search",
              ) as HTMLInputElement;
              if (sr) sr.style.display = "none";
              if (si) si.value = "";
            }
            openTaskDetail(taskId);
          }
        }
        document.body.addEventListener("click", handleTaskActivation, {
          signal: __signal,
        });
        // P1-3: Keyboard activation for kanban cards and task items
        document.body.addEventListener("keydown", handleTaskActivation, {
          signal: __signal,
        });

        // === Command Palette ===
        const cpOverlay = document.getElementById(
          "command-palette-overlay",
        ) as HTMLDivElement;
        const cpSearch = document.getElementById(
          "cp-search",
        ) as HTMLInputElement;
        const cpTasksSection = document.getElementById(
          "cp-tasks-section",
        ) as HTMLDivElement;
        const cpTasks = document.getElementById("cp-tasks") as HTMLDivElement;
        let cpAllTasks: Array<{ id: string; title: string }> = [];
        const cpFocusTrap = cpOverlay ? createFocusTrap(cpOverlay) : null;

        function openCP() {
          cpOverlay?.classList.remove("hidden");
          cpFocusTrap?.activate();
          cpSearch?.focus();
          // Load tasks for search
          fetch((window.__ingress_path || "") + "/api/tasks?limit=200")
            .then((r) => r.json())
            .then((data: { tasks: Array<{ id: string; title: string }> }) => {
              cpAllTasks = data.tasks || [];
            })
            .catch(() => {});
        }

        function closeCP() {
          cpFocusTrap?.deactivate();
          cpOverlay?.classList.add("hidden");
          if (cpSearch) cpSearch.value = "";
          cpTasksSection?.classList.add("hidden");
        }

        // Ctrl+K / Cmd+K
        document.addEventListener(
          "keydown",
          (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "k") {
              e.preventDefault();
              if (cpOverlay?.classList.contains("hidden")) openCP();
              else closeCP();
            }
            if (e.key === "Escape") {
              if (!tdOverlay?.classList.contains("hidden")) closeTD();
              if (!cpOverlay?.classList.contains("hidden")) closeCP();
            }
          },
          { signal: __signal },
        );

        cpOverlay?.addEventListener(
          "click",
          (e) => {
            if (e.target === cpOverlay) closeCP();
          },
          { signal: __signal },
        );

        // Search — filters both commands and tasks (P2-1: debounced 150ms)
        let cpSearchTimeout: ReturnType<typeof setTimeout> | null = null;
        cpSearch?.addEventListener(
          "input",
          () => {
            if (cpSearchTimeout) clearTimeout(cpSearchTimeout);
            cpSearchTimeout = setTimeout(() => {
              const q = cpSearch.value.toLowerCase().trim();
              // Filter static command items
              document
                .querySelectorAll("#cp-results > .cp-item[data-action]")
                .forEach((el) => {
                  const text =
                    (el as HTMLElement).textContent?.toLowerCase() ?? "";
                  (el as HTMLElement).style.display =
                    !q || text.includes(q) ? "" : "none";
                });
              // Also hide section headers if all children hidden
              document
                .querySelectorAll(
                  "#cp-results > div:not(.cp-item):not(#cp-tasks-section)",
                )
                .forEach((header) => {
                  const next = header.nextElementSibling;
                  if (
                    next?.classList.contains("cp-item") &&
                    (next as HTMLElement).style.display === "none"
                  ) {
                    (header as HTMLElement).style.display = "none";
                  } else {
                    (header as HTMLElement).style.display = "";
                  }
                });

              if (!q) {
                cpTasksSection?.classList.add("hidden");
                return;
              }

              const matches = cpAllTasks
                .filter((t) => t.title.toLowerCase().includes(q))
                .slice(0, 10);
              if (matches.length > 0) {
                cpTasksSection?.classList.remove("hidden");
                cpTasks.innerHTML = matches
                  .map(
                    (t) =>
                      `<div class="cp-item px-4 py-2.5 cursor-pointer hover:bg-bg-hover text-sm text-text-primary" data-task-id="${t.id}">${t.title}</div>`,
                  )
                  .join("");
              } else {
                cpTasksSection?.classList.add("hidden");
              }
            }, 150); // P2-1: 150ms debounce
          },
          { signal: __signal },
        );

        // Click handlers
        document.getElementById("cp-results")?.addEventListener(
          "click",
          (e) => {
            const target = (e.target as HTMLElement).closest(
              ".cp-item",
            ) as HTMLElement | null;
            if (!target) return;
            const action = target.dataset.action;
            const taskId = target.dataset.taskId;

            closeCP();

            if (action === "new-task") {
              // Open create modal if on tasks page, or navigate
              const createBtn = document.querySelector(
                "[data-action='create-task']",
              ) as HTMLElement;
              if (createBtn) createBtn.click();
              else
                window.location.href = (window.__ingress_path || "") + "/tasks";
            } else if (action === "new-board") {
              const boardBtn = document.querySelector(
                ".board-add-btn",
              ) as HTMLElement;
              if (boardBtn) boardBtn.click();
            } else if (action === "go-dashboard") {
              window.location.href = (window.__ingress_path || "") + "/";
            } else if (action === "go-kanban") {
              window.location.href = (window.__ingress_path || "") + "/kanban";
            } else if (action === "go-table") {
              window.location.href = (window.__ingress_path || "") + "/table";
            } else if (action === "go-settings") {
              window.location.href =
                (window.__ingress_path || "") + "/settings";
            } else if (action === "go-today") {
              window.location.href = (window.__ingress_path || "") + "/today";
            } else if (action === "go-upcoming") {
              window.location.href =
                (window.__ingress_path || "") + "/upcoming";
            } else if (action === "go-calendar") {
              window.location.href =
                (window.__ingress_path || "") + "/calendar";
            } else if (action === "export-csv") {
              window.location.href =
                (window.__ingress_path || "") + "/api/export/tasks.csv";
            } else if (taskId) {
              openTaskDetail(taskId);
            }
          },
          { signal: __signal },
        );
