        import { askAIForTask } from "@domains/ai/ai-context-service";
        import { createClientLogger } from "@lib/client-logger";

        const log = createClientLogger("tasks", "detail-modal");
        import { saveAttachment } from "@domains/offline/offline-store";
        import { confirmDialog } from "@lib/confirm-dialog";
        import { pageLifecycle } from "@lib/page-lifecycle";
        import { marked } from "marked";
        import { sanitizeClient } from "@lib/sanitize-client";
        import { onTaskCompleted } from "@lib/gamification-hook";
        import { renderTypeIconSvg } from "@lib/type-icon-config";
        import { escapeHtml } from "@lib/safe-html";
        import { loadComments, loadAttachments } from "@lib/controllers/modal-comments-attachments";
        import { initLabelsAndSubtasks } from "@lib/controllers/modal-labels-subtasks";
        import { initCustomFields } from "@lib/controllers/modal-custom-fields";
        import { initRelatedLinks } from "@lib/controllers/modal-related-links";
        import { initCommandPalette } from "@lib/controllers/modal-command-palette";

        // Use lifecycle signal for all global listeners in this module
        const __signal = pageLifecycle.signal;

        // === Task Detail Panel ===
        const tdOverlay = document.getElementById(
          "task-detail-overlay",
        ) as HTMLDivElement;
        let currentTaskId: string | null = null;
        let _modalAbortController: AbortController | null = null;
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
          if (!tdOverlay || !tdOverlay.classList.contains("active")) return;
          // Abort any in-flight fetches
          if (_modalAbortController) { _modalAbortController.abort(); _modalAbortController = null; }
          currentTaskId = null;

          const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

          const finishClose = () => {
            tdOverlay.classList.remove("active", "closing");
            document.body.style.overflow = "";
            history.pushState(null, "", window.location.pathname);
            // D1: Collapse sidebar on close (reset for next open)
            _sidebarProps?.classList.remove("td-sidebar-expanded");
            _sidebarToggle?.setAttribute("aria-expanded", "false");
            _sidebarChevron?.classList.remove("td-chevron-open");
            // P3-4: Restore focus to the element that triggered the panel
            if (_previouslyFocused && _previouslyFocused instanceof HTMLElement) {
              _previouslyFocused.focus();
              _previouslyFocused = null;
            }
          };

          if (reducedMotion) {
            finishClose();
            return;
          }

          tdOverlay.classList.add("closing");
          const panel = document.getElementById("task-detail-panel");
          if (panel) {
            const onEnd = () => { panel.removeEventListener("animationend", onEnd); finishClose(); };
            panel.addEventListener("animationend", onEnd, { once: true });
            // Safety fallback — never leave modal stuck
            setTimeout(() => { panel.removeEventListener("animationend", onEnd); finishClose(); }, 300);
          } else {
            finishClose();
          }
        }

        // F10: Mobile sidebar disclosure toggle
        const _sidebarToggle = document.getElementById("td-sidebar-toggle");
        const _sidebarProps = document.getElementById("td-sidebar-props");
        const _sidebarChevron = document.getElementById("td-sidebar-chevron");
        _sidebarToggle?.addEventListener("click", () => {
          const expanded = _sidebarProps?.classList.toggle("td-sidebar-expanded") ?? false;
          _sidebarToggle.setAttribute("aria-expanded", String(expanded));
          _sidebarChevron?.classList.toggle("td-chevron-open", expanded);
        });

        async function openTaskDetail(taskId: string) {
          if (!tdOverlay) return;
          // P3-4: Store focus origin for restore on close
          _previouslyFocused = document.activeElement;
          currentTaskId = taskId;
          if (_modalAbortController) _modalAbortController.abort();
          _modalAbortController = new AbortController();
          const modalSignal = _modalAbortController.signal;
          _isPopulating = true;
          tdOverlay.classList.add("active");
          // Lock body scroll while panel is open (closeTD restores it)
          document.body.style.overflow = "hidden";
          // Set dynamic aria-label for screen readers
          tdOverlay.setAttribute("aria-label", `Task detail: loading...`);
          // Show skeleton, hide loaded content
          const tdSkeleton = document.getElementById("td-skeleton");
          const tdLoaded = document.getElementById("td-loaded-content");
           if (tdSkeleton) tdSkeleton.style.display = "";
           if (tdLoaded) tdLoaded.classList.add("hidden");

           // D1: Auto-expand sidebar on mobile so properties are visible immediately
           if (window.matchMedia("(max-width: 767px)").matches) {
             _sidebarProps?.classList.add("td-sidebar-expanded");
             _sidebarToggle?.setAttribute("aria-expanded", "true");
             _sidebarChevron?.classList.toggle("td-chevron-open", true);
           }

          try {
            // Populate status dropdown from lanes API
            const statusSelect = document.getElementById(
              "td-status",
            ) as HTMLSelectElement | null;
            try {
              const [lanesRes, modeRes] = await Promise.all([
                fetch((window.__ingress_path || "") + "/api/lanes", {
                  signal: modalSignal,
                }),
                fetch(
                  (window.__ingress_path || "") +
                    "/api/settings?key=backlog_mode",
                  { signal: modalSignal },
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
              { signal: modalSignal },
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
                <a href="#" class="text-xs text-accent hover:underline td-parent-link" data-id="${escapeHtml(t.parent_id)}">${escapeHtml(parentTitle)}</a>
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
                  { signal: modalSignal },
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
                    { signal: modalSignal },
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
              // Render markdown preview (save=false prevents re-saving)
              try {
                const dirtyHtml = String(marked.parse(String(t.description) || "*No description provided.*"));
                if (descPreview) descPreview.innerHTML = sanitizeClient(dirtyHtml);
              } catch {}
              descEditContainer?.classList.add("hidden");
              descPreviewContainer?.classList.remove("hidden");
            } else {
              enterDescEdit();
            }

            (
              document.getElementById("td-priority") as HTMLSelectElement
            ).value = String(t.priority ?? 3);

            // Eisenhower dimensions
            const urgencyEl = document.getElementById("td-urgency") as HTMLSelectElement | null;
            if (urgencyEl) urgencyEl.value = String(t.urgency ?? 0);
            const importanceEl = document.getElementById("td-importance") as HTMLSelectElement | null;
            if (importanceEl) importanceEl.value = String(t.importance ?? 0);
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
            const areaSelect = document.getElementById(
              "td-area",
            ) as HTMLSelectElement;
            const currentAreaId = String(t.area_id ?? "default");
            try {
              const boardRes = await fetch(
                (window.__ingress_path || "") + "/api/areas",
                { signal: modalSignal },
              );
              if (boardRes.ok) {
                const areaData = await boardRes.json();
                const boards = areaData.areas ?? [];
                areaSelect.innerHTML = "";
                boards.forEach(
                  (b: { id: string; name: string; icon: string }) => {
                    const opt = document.createElement("option");
                    opt.value = b.id;
                    opt.textContent = `${b.icon} ${b.name}`;
                    areaSelect.appendChild(opt);
                  },
                );
                areaSelect.value = currentAreaId;
              }
            } catch {
              areaSelect.innerHTML = `<option value="${currentAreaId}">${currentAreaId}</option>`;
            }
            // Populate project dropdown
            const projectSelect = document.getElementById(
              "td-project",
            ) as HTMLSelectElement;
            const currentProjectId = String(t.project_id ?? "");
            try {
              const projRes = await fetch(
                (window.__ingress_path || "") + "/api/projects",
                { signal: modalSignal },
              );
              if (projRes.ok) {
                const projData = await projRes.json();
                const projects = projData.projects ?? projData ?? [];
                projectSelect.innerHTML = '<option value="">No project</option>';
                (projects as Array<{ id: string; title: string; icon?: string }>).forEach((p) => {
                  const opt = document.createElement("option");
                  opt.value = p.id;
                  opt.textContent = `${p.icon ?? "📋"} ${p.title}`;
                  projectSelect.appendChild(opt);
                });
                projectSelect.value = currentProjectId;
              }
            } catch {
              projectSelect.innerHTML = `<option value="${currentProjectId}">${currentProjectId}</option>`;
            }

            // Populate pillar dropdown
            const pillarSelect = document.getElementById(
              "td-pillar",
            ) as HTMLSelectElement;
            const currentPillarId = String(t.pillar_id ?? "");
            try {
              const pilRes = await fetch(
                (window.__ingress_path || "") + "/api/pillars",
                { signal: modalSignal },
              );
              if (pilRes.ok) {
                const pilData = await pilRes.json();
                const pillars = pilData.pillars ?? pilData ?? [];
                pillarSelect.innerHTML = '<option value="">No pillar</option>';
                (pillars as Array<{ id: string; name: string; icon?: string }>).forEach((p) => {
                  const opt = document.createElement("option");
                  opt.value = p.id;
                  opt.textContent = `${p.icon ?? "🏛️"} ${p.name}`;
                  pillarSelect.appendChild(opt);
                });
                pillarSelect.value = currentPillarId;
              }
            } catch {
              pillarSelect.innerHTML = `<option value="${currentPillarId}">${currentPillarId}</option>`;
            }

            // Populate principle dropdown
            const principleSelect = document.getElementById(
              "td-principle",
            ) as HTMLSelectElement;
            const currentPrincipleId = String(t.principle_id ?? "");
            try {
              if (currentPillarId && currentPillarId !== "null" && currentPillarId !== "undefined") {
                const prinRes = await fetch(
                  (window.__ingress_path || "") + `/api/pillars/${currentPillarId}/principles`,
                  { signal: modalSignal },
                );
                if (prinRes.ok) {
                  const prinData = await prinRes.json();
                  const principles = prinData.principles ?? prinData ?? [];
                  principleSelect.innerHTML = '<option value="">No principle</option>';
                  (principles as Array<{ id: string; description: string }>).forEach((p) => {
                    const opt = document.createElement("option");
                    opt.value = p.id;
                    opt.textContent = `⚖️ ${p.description.substring(0, 30)}${p.description.length > 30 ? '...' : ''}`;
                    principleSelect.appendChild(opt);
                  });
                  principleSelect.value = currentPrincipleId;
                }
              } else {
                 principleSelect.innerHTML = '<option value="">No principle</option>';
              }
            } catch {
              principleSelect.innerHTML = `<option value="${currentPrincipleId}">${currentPrincipleId}</option>`;
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
                  { signal: modalSignal },
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
                { signal: modalSignal },
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
            labelsApi.setCurrentLabels([]);
            try {
              const labels = JSON.parse(String(t.labels ?? "[]"));
              if (Array.isArray(labels)) {
                const parsed = labels.map((l: string | { name: string }) =>
                  typeof l === "string" ? l : l.name,
                );
                labelsApi.setCurrentLabels(parsed);
                parsed.forEach((lbl: string) => addLabelChip(lbl));
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
              type ChecklistItem = { id: string; text: string; done: boolean }
              const list = (window.__currentChecklists || []) as ChecklistItem[];
              if (checklistsContainer) {
                checklistsContainer.innerHTML = "";
                let doneCount = 0;
                list.forEach((item: ChecklistItem, index: number) => {
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
            // Hide skeleton, show loaded content
            if (tdSkeleton) tdSkeleton.style.display = "none";
            if (tdLoaded) {
              tdLoaded.classList.remove("hidden");
              const titleEl = document.getElementById("td-title") as HTMLTextAreaElement;
              if (titleEl) {
                titleEl.style.height = "auto";
                setTimeout(() => {
                  titleEl.style.height = titleEl.scrollHeight + "px";
                }, 10);
              }
            }
            setTimeout(() => { _isPopulating = false }, 100);
          } catch (e) {
            if ((e as { name?: string })?.name === "AbortError") {
              return;
            }
            log.error("Failed to load task detail", e);
            _isPopulating = false;
            // Hide skeleton on error too so error message is visible
            if (tdSkeleton) tdSkeleton.style.display = "none";
            if (tdLoaded) {
              tdLoaded.classList.remove("hidden");
              const titleEl = document.getElementById("td-title") as HTMLTextAreaElement;
              if (titleEl) {
                titleEl.style.height = "auto";
                // Short timeout to let browser layout engine catch up with visibility
                setTimeout(() => {
                  titleEl.style.height = titleEl.scrollHeight + "px";
                }, 10);
              }
            }
            // Show error state in modal instead of closing — better UX for transient errors
            const titleEl = document.getElementById("td-title") as HTMLTextAreaElement | null;
            if (titleEl) {
              titleEl.value = "⚠ Failed to load task";
              titleEl.readOnly = true;
            }
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
            if (!res.ok) {
              log.warn(`Failed to save ${field}:`, res.status);
              const { showToast } = await import("@lib/toast");
              showToast("common.failed_update", "error");
            }
          } catch (err) {
            log.warn(`Network error saving ${field}:`, err);
          }
        }

        // F11: Description Edit/Preview UX (simplified)
        const descEditContainer = document.getElementById("td-desc-edit-container");
        const descPreviewContainer = document.getElementById("td-desc-preview-container");
        const descPreview = document.getElementById("td-desc-preview");
        const tdDescription = document.getElementById("td-description") as HTMLTextAreaElement;
        const descEditBtnHover = document.getElementById("td-desc-edit-btn-hover");
        const descSaveBtn = document.getElementById("td-desc-save-btn");
        const descCancelBtn = document.getElementById("td-desc-cancel-btn");
        const descSavedIndicator = document.getElementById("td-desc-saved");

        let _descOriginalValue = "";
        let _descSavedTimer: number | null = null;

        function enterDescEdit() {
          _descOriginalValue = tdDescription?.value ?? "";
          descEditContainer?.classList.remove("hidden");
          descPreviewContainer?.classList.add("hidden");
          tdDescription?.focus();
        }

        function exitDescEdit(save: boolean) {
          descEditContainer?.classList.add("hidden");
          descPreviewContainer?.classList.remove("hidden");
          if (!save && tdDescription) {
            tdDescription.value = _descOriginalValue;
          }
          if (save && descPreview && tdDescription) {
            const rawMarkdown = tdDescription.value;
            try {
              const dirtyHtml = marked.parse(rawMarkdown || "*No description provided.*") as string;
              descPreview.innerHTML = sanitizeClient(dirtyHtml);
            } catch (e: any) {
              log.error("Markdown render error", e);
              descPreview.innerHTML = `<div class="text-red-500">Error rendering markdown: ${escapeHtml(e.message)}</div>`;
            }
            saveTD("description", rawMarkdown);
            // Show "✓ Saved" indicator (T4: guarded with timeout tracking)
            if (descSavedIndicator) {
              descSavedIndicator.style.display = "";
              if (_descSavedTimer) clearTimeout(_descSavedTimer);
              _descSavedTimer = window.setTimeout(() => { descSavedIndicator.style.display = "none"; _descSavedTimer = null; }, 1500);
            }
          }
        }

        descEditBtnHover?.addEventListener("click", () => enterDescEdit());
        // T9: Only enter edit mode when clicking preview container background, not rendered links/code
        descPreviewContainer?.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          if (target.closest("a, code, pre, img")) return;
          enterDescEdit();
        });
        descSaveBtn?.addEventListener("click", () => exitDescEdit(true));
        descCancelBtn?.addEventListener("click", () => exitDescEdit(false));
        // T7: Cmd/Ctrl+S shortcut in description edit mode
        tdDescription?.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            exitDescEdit(true);
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
        // Duplicate title blur listener removed — already handled above at line 1066
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
                log.error("Failed to save attachment", err);
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
        // Eisenhower urgency auto-save
        document
          .getElementById("td-urgency")
          ?.addEventListener("change", (e) =>
            saveTD("urgency", Number((e.target as HTMLSelectElement).value)),
          );
        // Eisenhower importance auto-save
        document
          .getElementById("td-importance")
          ?.addEventListener("change", (e) =>
            saveTD("importance", Number((e.target as HTMLSelectElement).value)),
          );
        // Phase 20: task_type auto-save
        document
          .getElementById("td-task-type")
          ?.addEventListener("change", (e) => {
            saveTD("task_type", (e.target as HTMLSelectElement).value);
          });
        // Phase 26: board change auto-save
        document.getElementById("td-area")?.addEventListener("change", (e) => {
          saveTD("area_id", (e.target as HTMLSelectElement).value);
        });
        // Project change auto-save
        document.getElementById("td-project")?.addEventListener("change", (e) => {
          saveTD("project_id", (e.target as HTMLSelectElement).value || null);
        });

        // Pillar change auto-save & dynamic Principle update
        document.getElementById("td-pillar")?.addEventListener("change", async (e) => {
          const pillarId = (e.target as HTMLSelectElement).value || null;
          saveTD("pillar_id", pillarId);
          // Auto-clear principle when pillar changes
          saveTD("principle_id", null);
          const principleSelect = document.getElementById("td-principle") as HTMLSelectElement | null;
          if (principleSelect) {
            principleSelect.innerHTML = '<option value="">No principle</option>';
            if (pillarId) {
              try {
                const prinRes = await fetch(
                  (window.__ingress_path || "") + `/api/pillars/${pillarId}/principles`,
                );
                if (prinRes.ok) {
                  const prinData = await prinRes.json();
                  const principles = prinData.principles || prinData || [];
                  principles.forEach((p: any) => {
                    const opt = document.createElement("option");
                    opt.value = p.id;
                    opt.textContent = `⚖️ ${p.description.substring(0, 30)}${p.description.length > 30 ? '...' : ''}`;
                    principleSelect.appendChild(opt);
                  });
                }
              } catch {}
            }
          }
        });

        // Principle change auto-save
        document.getElementById("td-principle")?.addEventListener("change", (e) => {
          saveTD("principle_id", (e.target as HTMLSelectElement).value || null);
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

        // ───── Labels + Subtasks (extracted) ─────
        const labelsApi = initLabelsAndSubtasks({
          saveTD,
          getCurrentTaskId: () => currentTaskId,
          openTaskDetail,
        })
        const addLabelChip = labelsApi.addLabelChip


        // ───── Custom Fields (extracted) ─────
        const cfApi = initCustomFields({
          saveTD,
          getSettingsFields: () => _settingsFields,
        })
        const addCFRow = cfApi.addCFRow


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

        // ───── Related Links (extracted) ─────
        const relatedLinksApi = initRelatedLinks({
          getCurrentTaskId: () => currentTaskId,
          openTaskDetail,
          saveTD,
        })
        const loadRelatedLinks = relatedLinksApi.loadRelatedLinks


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
              log.error("AI context error", err);
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
                log.error("Attachment failed", err);
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
                document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "task-deleted" } }));
              }
            } catch {
              // Network error — still close and refresh to re-sync
              closeTD();
              document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "task-delete-fallback" } }));
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
              tdOverlay.classList.contains("active")
            ) {
              // Hash cleared (back button pressed) → close the detail panel
              closeTD();
            }
          } catch (err) {
            log.warn("Hash navigation error", err);
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

        // === Command Palette (extracted) ===
        initCommandPalette({ openTaskDetail, closeTD, __signal })

