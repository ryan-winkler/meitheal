        import { askAIForTask } from "@domains/ai/ai-context-service";
        import { createClientLogger } from "@lib/client-logger";
        import { copyToClipboard } from "@lib/clipboard"
        import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
        import {
          buildTaskPermalink, getLegacyTaskId, type SearchDetailDismissal, type SearchDetailHandoff,
        } from "@lib/task-detail-handoff"
        import { buildIngressPagePath } from "@lib/page-shell-links"
        import { taskDetailPath, ticketIdFromPath, taskBackgroundUrl } from "@lib/task-page-url"

        const log = createClientLogger("tasks", "detail-modal");
        import { saveAttachment } from "@domains/offline/offline-store";
        import { confirmDialog } from "@lib/confirm-dialog";
        import { pageLifecycle } from "@lib/page-lifecycle";
        import { marked } from "marked";
        import { sanitizeClient } from "@lib/sanitize-client";
        import { onTaskCompleted } from "@lib/gamification-hook";
        import { renderTypeIconSvg } from "@lib/type-icon-config";
        import { escapeHtml } from "@lib/safe-html";
        import { showToast } from "@lib/toast"
        import { loadComments, loadAttachments } from "@lib/controllers/modal-comments-attachments";
        import { initLabelsAndSubtasks } from "@lib/controllers/modal-labels-subtasks";
        import { initCustomFields } from "@lib/controllers/modal-custom-fields";
        import { initRelatedLinks } from "@lib/controllers/modal-related-links";
        import { initCommandPalette } from "@lib/controllers/modal-command-palette";
        import { pendingChecklistSave, showTaskChecklist } from "@lib/controllers/modal-checklist"
        import { notifyInactivityTaskChanged } from "@lib/inactivity-client"
        import { isActiveParticipantProblem } from "@lib/task-participant-problem"
        import { mountReactions } from "@lib/controllers/modal-reactions"
        import { initModalDeferral } from "@lib/controllers/modal-deferral"
        import { initModalTaskPin } from "@lib/controllers/modal-task-pin"
        import { commentMentionWriteHeaders, readCommentMentionProblem } from "@lib/comment-mention-client"
        import { commentAttemptHeader, commentMentionContextHeader } from "@lib/comment-mentions"
        import { initModalTaskReferences } from "@lib/controllers/modal-task-references"
        import { resolveDescriptionTaskReferences } from "@lib/task-references"

        // Use lifecycle signal for all global listeners in this module
        pageLifecycle.onPageLoad(() => {
          const __signal = pageLifecycle.signal;

          // === Task Detail Panel ===
          const tdOverlay = document.getElementById(
            "task-detail-overlay",
          ) as HTMLDivElement;
        if (!tdOverlay || tdOverlay.dataset.detailController === "ready") return
        tdOverlay.dataset.detailController = "ready"
        let pinnedSession: {
          reconcile: () => void; dirty: boolean; pending: number; queued?: () => void
        } | undefined
        let searchSession: {
          handoff: SearchDetailHandoff
          lifetime: AbortController
          dirty: boolean
          pending: number
          queued?: () => void
        } | undefined
        let detailGeneration = 0
        const deferral = initModalDeferral(tdOverlay, __signal)
        const pins = initModalTaskPin(tdOverlay, __signal, () => { if (pinnedSession) pinnedSession.dirty = true })
        const closeTaskReferences = initModalTaskReferences(tdOverlay, __signal)
        const tdClose = document.getElementById("td-close")
        const tdHeading = document.getElementById("td-task-heading")
        const tdActions = document.getElementById("td-task-actions")
        const tdError = document.getElementById("td-load-error")
        const copyFallback = document.getElementById("td-copy-link-fallback")
        const copyValue = document.querySelector<HTMLInputElement>("#td-copy-link-value")
        const commentInput = document.querySelector<HTMLTextAreaElement>("#td-comment-input")
        const commentButton = document.querySelector<HTMLButtonElement>("#td-comment-submit")
        const commentError = document.getElementById("td-comment-error")
        let currentTaskId: string | null = null;
        let currentCommentTarget: string | null = null
        let commentsReady: Promise<void> = Promise.resolve()
        let _modalAbortController: AbortController | null = null;
        __signal.addEventListener("abort", () => {
          _modalAbortController?.abort()
          searchSession?.lifetime.abort()
          searchSession?.handoff.onDismiss("history")
          searchSession = undefined
          delete tdOverlay.dataset.detailController
        }, { once: true })
        let _isPopulating = false;
        // P3-4/P22: Focus management — restore focus to trigger element on panel close
        let _previouslyFocused: Element | null = null;
        let _settingsFields: Array<{
          name: string;
          type: string;
          options?: string[];
        }> = [];
        const RICE_KEYS = ["Reach", "Impact", "Confidence", "Effort"];
        const drawerSession = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
          byte => byte.toString(16).padStart(2, "0")).join("")
        tdOverlay.dataset.ticketHistorySession = drawerSession

        function beginScopedWrite() {
          const search = searchSession
          const session = pinnedSession ?? search
          if (!session) return undefined
          session.pending++
          session.dirty = true
          return {
            signal: AbortSignal.any([__signal, AbortSignal.timeout(7_000)]),
            finish() {
              if (--session.pending !== 0) return
              const next = session.queued
              delete session.queued
              if (search && search !== searchSession && !__signal.aborted) {
                deferral.reconcileSearch()
                return
              }
              if (next && !__signal.aborted && session === (pinnedSession ?? searchSession)) queueMicrotask(next)
            },
          }
        }

        function waitForDetailWrites(next: () => void): boolean {
          const generation = detailGeneration
          const run = () => { if (generation === detailGeneration) next() }
          const session = pinnedSession ?? searchSession
          if (session?.pending) {
            session.queued = run
            return true
          }
          return deferral.waitForWrite(run) || pins.waitForWrite(run)
        }

        function setTaskLocation(taskId: string | null, replace = false, commentTarget: string | null = null) {
          if (pinnedSession || searchSession) return
          const url = new URL(window.location.href)
          const ticket = ticketIdFromPath(url.pathname, window.__ingress_path)
          if (taskId) {
            const target = new URL(buildIngressPagePath(taskDetailPath(taskId)), url.origin)
            if (commentTarget !== null) target.searchParams.set("comment", commentTarget)
            if (target.href === url.href) return
            if (ticket !== null) {
              history.replaceState(history.state, "", target)
              return
            }
            const legacy = url.searchParams.has("open") || getLegacyTaskId(url.hash) !== null
            url.searchParams.delete("open")
            url.searchParams.delete("comment")
            if (getLegacyTaskId(url.hash) !== null) url.hash = ""
            const state = { ...history.state, ticketDrawer: { returnTo: url.href, session: drawerSession, pushed: !legacy && !replace } }
            if (legacy || replace) history.replaceState(state, "", target)
            else {
              history.replaceState({ ...history.state, ticketBackground: drawerSession }, "")
              history.pushState(state, "", target)
            }
          } else if (ticket !== null) {
            if (history.state?.ticketDrawer?.pushed) history.back()
            else history.replaceState(history.state, "", taskBackgroundUrl(url))
          }
        }

        function closeTD(reason: SearchDetailDismissal = "dismiss", updateLocation = true) {
          const search = searchSession
          const immediate = reason === "history" && Boolean(search)
          if (!tdOverlay?.classList.contains("active") || (!immediate && tdOverlay.classList.contains("closing"))) return
          if (!immediate && waitForDetailWrites(() => closeTD(reason, updateLocation))) return
          const closing = ++detailGeneration
          closeTaskReferences()
          search?.lifetime.abort()
          deferral.opening(false)
          pins.opening()
          // Abort any in-flight fetches
          if (_modalAbortController) { _modalAbortController.abort(); _modalAbortController = null; }
          currentTaskId = null;
          currentCommentTarget = null
          delete tdOverlay.dataset.openTaskId
          if (updateLocation) setTaskLocation(null)

          const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

          const finishClose = () => {
            if (closing !== detailGeneration || currentTaskId !== null || !tdOverlay.classList.contains("active")) return
            tdOverlay.classList.remove("active", "closing");
            document.body.style.overflow = "";
            // D1: Collapse sidebar on close (reset for next open)
            _sidebarProps?.classList.remove("td-sidebar-expanded");
            _sidebarToggle?.setAttribute("aria-expanded", "false");
            _sidebarChevron?.classList.remove("td-chevron-open");
            // P3-4: Restore focus to the element that triggered the panel
            if (!search && _previouslyFocused instanceof HTMLElement &&
                _previouslyFocused !== document.body && _previouslyFocused.isConnected) {
              _previouslyFocused.focus()
            } else if (!search) {
              document.querySelector<HTMLElement>('[data-view-tab][aria-current="page"], #triage-heading, #deferred-heading, #pinned-heading')?.focus()
            }
            _previouslyFocused = null
            const closed = pinnedSession
            pinnedSession = undefined
            searchSession = undefined
            const deferralChanged = deferral.closed(Boolean(closed), Boolean(search))
            if (closed && (closed.dirty || deferralChanged)) closed.reconcile()
            if (search?.dirty && !search.pending && !deferralChanged) deferral.reconcileSearch()
            search?.handoff.onDismiss(reason)
          };

          if (reducedMotion || immediate) {
            finishClose();
            return;
          }

          tdOverlay.classList.add("closing");
          const panel = document.getElementById("task-detail-panel");
          if (panel) {
            const onEnd = () => { panel.removeEventListener("animationend", onEnd); finishClose(); };
            panel.addEventListener("animationend", onEnd, { once: true, signal: __signal });
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
        }, { signal: __signal });

        async function openTaskDetail(taskId: string, commentTarget: string | null = null, search?: SearchDetailHandoff, updateLocation = true) {
          if (!tdOverlay?.isConnected || __signal.aborted) return
          const newSession = !tdOverlay.classList.contains("active")
          if (search && !newSession) {
            search.onDismiss("history")
            return
          }
          if (waitForDetailWrites(() => { void openTaskDetail(taskId, commentTarget, search, updateLocation) })) return
          if (search) searchSession = { handoff: search, lifetime: new AbortController(), dirty: false, pending: 0 }
          detailGeneration++
          closeTaskReferences()
          deferral.opening(newSession)
          pins.opening()
          // P3-4: Store focus origin for restore on close
          if (newSession) _previouslyFocused = search ? null : document.activeElement
          currentTaskId = taskId;
          currentCommentTarget = commentTarget
          tdOverlay.dataset.openTaskId = taskId
          if (updateLocation) setTaskLocation(taskId, false, commentTarget)
          if (_modalAbortController) _modalAbortController.abort();
          _modalAbortController = new AbortController();
          const modalSignal = _modalAbortController.signal
          document.getElementById("td-ai-response")?.remove()
          _isPopulating = true;
          const projectField = document.querySelector<HTMLSelectElement>("#td-project")
          let projectFieldReady = false
          if (projectField) projectField.disabled = true
          tdOverlay.classList.remove("closing")
          tdOverlay.classList.add("active");
          tdClose?.focus()
          // Lock body scroll while panel is open (closeTD restores it)
          document.body.style.overflow = "hidden";
          // Set dynamic aria-label for screen readers
          tdOverlay.setAttribute("aria-label", `Task detail: loading...`);
          // Show skeleton, hide loaded content
          const tdSkeleton = document.getElementById("td-skeleton");
          const tdLoaded = document.getElementById("td-loaded-content");
           if (tdSkeleton) tdSkeleton.style.display = "";
           if (tdLoaded) tdLoaded.classList.add("hidden");
           tdHeading?.classList.add("invisible")
           tdActions?.setAttribute("hidden", "")
           tdError?.setAttribute("hidden", "")
           copyFallback?.setAttribute("hidden", "")

          function showTaskError(unavailable: boolean) {
            currentTaskId = null
            _isPopulating = false
            if (tdSkeleton) tdSkeleton.style.display = "none"
            tdOverlay.setAttribute("aria-label", "Task detail")
            if (tdError) {
              tdError.textContent = (unavailable ? tdError.dataset.unavailable : tdError.dataset.failed) ?? null
              tdError.hidden = false
            }
          }

           // D1: Auto-expand sidebar on mobile so properties are visible immediately
           if (window.matchMedia("(max-width: 767px)").matches) {
             _sidebarProps?.classList.add("td-sidebar-expanded");
             _sidebarToggle?.setAttribute("aria-expanded", "true");
             _sidebarChevron?.classList.toggle("td-chevron-open", true);
           }

          try {
            if (!taskId.trim() || taskId === "." || taskId === "..") {
              showTaskError(true)
              return
            }
            const pendingChecklist = pendingChecklistSave(taskId)
            if (pendingChecklist) {
              await pendingChecklist
              if (modalSignal.aborted) return
            }
            const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
              signal: modalSignal,
              ...(pendingChecklist ? { cache: "no-store" } : {}),
            })
            if (modalSignal.aborted) return
            if (!res.ok) {
              showTaskError([401, 403, 404].includes(res.status))
              return
            }
            const t = (await res.json()) as Record<string, unknown>
            if (modalSignal.aborted) return
            const requestedTicket = /^MTH-(\d+)$/i.exec(taskId)
            if (!t.id || (requestedTicket && Number(requestedTicket[1]) !== Number(t.ticket_number))) {
              showTaskError(false)
              return
            }
            taskId = String(t.id)
            currentTaskId = taskId
            setTaskLocation(taskId, true, commentTarget)

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
                statusSelect.replaceChildren();
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

            if (modalSignal.aborted) return

            const parentEl = document.getElementById(
              "td-parent",
            ) as HTMLAnchorElement | null;
            if (parentEl && t.parent_id) {
              parentEl.textContent = `↑ ${t.parent_ticket_key ?? t.parent_title ?? t.parent_id}`;
              parentEl.href = buildTaskPermalink(String(t.parent_id))
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
                const parentLink = document.createElement("a");
                parentLink.href = "#";
                parentLink.className = "text-xs text-accent hover:underline td-parent-link";
                parentLink.dataset.id = String(t.parent_id);
                parentLink.textContent = parentTitle;
                const unlinkBtn = document.createElement("button");
                unlinkBtn.type = "button";
                unlinkBtn.className = "text-xs text-danger hover:text-red-400 ml-1 td-unlink-parent";
                unlinkBtn.title = "Remove parent";
                unlinkBtn.textContent = "✕";
                linkParentDisplay.replaceChildren(parentLink, document.createTextNode(" "), unlinkBtn);
                linkParentDisplay
                  .querySelector(".td-parent-link")
                  ?.addEventListener("click", (e) => {
                    e.preventDefault();
                    openTaskDetail(String(t.parent_id));
                  });
                linkParentDisplay
                  .querySelector(".td-unlink-parent")
                  ?.addEventListener("click", async () => {
                    const unlinkTaskId = currentTaskId
                    const confirmed = await confirmDialog({
                      message: t.title ? `Unlink parent from "${t.title}"?` : "Unlink parent?",
                      title: "Unlink",
                      signal: modalSignal,
                    })
                    if (!confirmed || !unlinkTaskId || currentTaskId !== unlinkTaskId) return
                    if (await saveTaskField("parent_id", null) && currentTaskId === unlinkTaskId) {
                      openTaskDetail(unlinkTaskId)
                    }
                  }, { signal: modalSignal });
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
              childrenDiv.replaceChildren();
              // Progress bar elements
              const progressWrap = document.getElementById("td-subtask-progress");
              const progressLabel = document.getElementById("td-subtask-progress-label");
              const progressBar = document.getElementById("td-subtask-progress-bar");
              try {
                const childRes = await fetch(
                  `${window.__ingress_path || ""}/api/tasks?parent_id=${taskId}`,
                  { signal: __signal },
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
                      else progressBar.className = "h-full bg-accent rounded-full transition-[width,background-color] duration-300";
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
              activityDiv.replaceChildren();
              const loadActivity = async () => {
                try {
                  const actRes = await fetch(
                    `/api/tasks/${encodeURIComponent(taskId)}/activity`,
                    { signal: __signal, cache: "no-store" },
                  );
                  const cacheDirectives = actRes.headers.get("cache-control")?.toLowerCase().split(",")
                  if (!actRes.ok || !cacheDirectives?.some(value => value.trim() === "no-store")) return
                  const actData = await actRes.json();
                  const entries = Array.isArray(actData)
                    ? actData
                    : (actData.activity ?? []);
                  if (!Array.isArray(entries) || entries.length === 0) {
                    activityDiv.innerHTML = `<span class="text-text-muted italic">No activity yet</span>`;
                    return;
                  }
                  activityDiv.replaceChildren();
                  for (const e of entries.slice(0, 50)) {
                    const ago = new Date(Number(e.created_at)).toLocaleString();
                    const row = document.createElement("div");
                    row.className =
                      "flex gap-2 items-baseline py-1 border-b border-border/30";
                    const agoSpan = document.createElement("span");
                    agoSpan.className = "text-text-muted shrink-0";
                    agoSpan.textContent = ago;
                    const fieldSpan = document.createElement("span");
                    fieldSpan.className = "font-medium text-text-primary";
                    fieldSpan.textContent = String(e.field ?? "");
                    const arrowSpan = document.createElement("span");
                    arrowSpan.className = "text-text-muted";
                    arrowSpan.textContent = "→";
                    const valSpan = document.createElement("span");
                    valSpan.className = "text-accent truncate";
                    valSpan.textContent = String(e.new_value ?? "—").slice(0, 60);
                    row.append(agoSpan, fieldSpan, arrowSpan, valSpan);
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
              const iconDoc = new DOMParser().parseFromString(renderTypeIconSvg(tt, 16), "text/html");
              typeIconEl.replaceChildren(...Array.from(iconDoc.body.childNodes));
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
                renderTaskDescription(String(t.description))
              } catch (e) { log.warn("markdown-preview error", e) }
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
                { signal: __signal },
              );
              if (boardRes.ok) {
                const areaData = await boardRes.json();
                const boards = areaData.areas ?? [];
                areaSelect.replaceChildren();
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
              areaSelect.replaceChildren(new Option(currentAreaId, currentAreaId));
            }
            if (projectField) {
              const savedProject = String(t.project_id ?? "")
              try {
                const response = await fetch("/api/projects", { signal: modalSignal })
                if (!response.ok) throw new Error("Projects unavailable")
                const data = await response.json()
                if (modalSignal.aborted) return
                const projects = (data.projects ?? data) as Array<{ id: string, title: string, icon?: string }>
                projectField.replaceChildren(new Option("No project", ""))
                for (const project of projects) {
                  projectField.add(new Option(`${project.icon ?? "📋"} ${project.title}`, project.id))
                }
                if (savedProject && !projects.some(project => project.id === savedProject)) {
                  const unavailable = new Option("Unavailable project", savedProject)
                  unavailable.disabled = true
                  projectField.add(unavailable)
                }
                projectField.value = savedProject
                projectField.dataset.savedProject = savedProject
                projectFieldReady = true
              } catch {
                if (!modalSignal.aborted) {
                  projectField.replaceChildren(new Option(savedProject ? "Unavailable project" : "No project", savedProject))
                }
              }
            }

            // Populate pillar dropdown
            const pillarSelect = document.getElementById(
              "td-pillar",
            ) as HTMLSelectElement;
            const currentPillarId = String(t.pillar_id ?? "");
            try {
              const pilRes = await fetch(
                (window.__ingress_path || "") + "/api/pillars",
                { signal: __signal },
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
              pillarSelect.replaceChildren(new Option(currentPillarId, currentPillarId));
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
                  { signal: __signal },
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
              principleSelect.replaceChildren(new Option(currentPrincipleId, currentPrincipleId));
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
                  { signal: __signal },
                );
                if (usersRes.ok) {
                  const usersData = await usersRes.json();
                  const users = usersData.users ?? [];
                  assignSelect.innerHTML =
                    '<option value="">Unassigned</option>';
                  for (const u of users) {
                    const opt = document.createElement("option");
                    opt.value = u.id;
                    opt.textContent = (u.display_name ?? u.name ?? u.id) + (u.kind === "agent" ? " (AI agent)" : "");
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
              const settingsRes = await fetch("/api/settings", { signal: modalSignal })
              if (settingsRes.ok) {
                allSettings = await settingsRes.json();
                if (modalSignal.aborted || currentTaskId !== taskId) return
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
            if (modalSignal.aborted || currentTaskId !== taskId) return
            if (window.attachStrategicLens) {
              const lensGeneration = detailGeneration
              window.attachStrategicLens(
                taskId,
                String(t.task_type ?? "task"),
                String(t.framework_payload ?? "{}"),
                allSettings,
                {
                  signal: modalSignal,
                  save: (payload, updatedAt) => lensGeneration === detailGeneration && currentTaskId === taskId
                    ? saveTaskField("framework_payload", payload, updatedAt) : Promise.resolve(false),
                },
              );
            }

            // Labels (interactive chips)
            const labelsDiv = document.getElementById(
              "td-labels",
            ) as HTMLElement;
            labelsDiv.replaceChildren();
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
            cfDiv.replaceChildren();
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
            showTaskChecklist(taskId, t.checklists, modalSignal, typeof t.ticket_key === "string" ? t.ticket_key : undefined)
            const taskReactions = document.getElementById("td-task-reactions")
            if (taskReactions) {
              taskReactions.replaceChildren()
              mountReactions(taskReactions, `/api/tasks/${encodeURIComponent(taskId)}/reactions`, modalSignal, taskId)
            }

            // Load comments for the current task.
            document.getElementById("td-comments")?.replaceChildren()
            document.getElementById("td-comment-link-status")?.replaceChildren()
            commentError?.setAttribute("hidden", "")
            if (commentButton) commentButton.disabled = false
            if (commentInput && commentInput.dataset.taskId !== taskId) {
              commentInput.value = ""
              commentInput.dataset.taskId = taskId
            }
            commentsReady = loadComments(taskId, modalSignal, commentTarget)

            // Load attachments (Phase 23)
            loadAttachments(taskId);
            // Delay resetting _isPopulating so blur/change events that
            // fire asynchronously during focus transitions don't trigger
            // spurious save notifications
            // Hide skeleton, show loaded content
            if (modalSignal.aborted) return
            if (tdSkeleton) tdSkeleton.style.display = "none";
            tdHeading?.classList.remove("invisible")
            tdActions?.removeAttribute("hidden")
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
            setTimeout(() => {
              if (modalSignal.aborted) return
              _isPopulating = false
              if (projectField) projectField.disabled = !projectFieldReady
              deferral.loaded(taskId, typeof t.project_id === "string" ? t.project_id : null, t.deferred_at != null, modalSignal, Boolean(searchSession))
              pins.loaded(taskId, modalSignal)
            }, 100)
          } catch (e) {
            if (modalSignal.aborted) return
            log.error("Failed to load task detail", e);
            showTaskError(false)
          }
        }



        async function saveTaskField(field: string, value: unknown, updatedAt?: number): Promise<boolean> {
          if (!currentTaskId || _isPopulating) return false
          const generation = detailGeneration
          const taskId = currentTaskId
          const search = searchSession
          const completeDeferralWrite = deferral.nativeWrite(field, value)
          const scopedWrite = search || ["title", "status", "project_id", "framework_payload"].includes(field) ? beginScopedWrite() : undefined
          let saved = false
          try {
            const response = await fetch(`/api/tasks/${taskId}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ [field]: value, ...(updatedAt === undefined ? {} : { updated_at: updatedAt }) }),
              ...(scopedWrite ? { signal: scopedWrite.signal } : {}),
            })
            saved = response.ok
            if (saved) {
              notifyInactivityTaskChanged(field === "status" ? undefined : taskId)
              if (field === "status" && value === "complete" && (!search || generation === detailGeneration)) {
                onTaskCompleted(await response.json())
              }
              return !search || generation === detailGeneration
            }
            log.warn(`Failed to save ${field}:`, response.status)
          } catch (err) {
            log.warn(`Network error saving ${field}:`, err)
          } finally {
            completeDeferralWrite(saved)
            scopedWrite?.finish()
          }
          if (search && generation !== detailGeneration) return false
          const { showToast } = await import("@lib/toast")
          if (!search || generation === detailGeneration) showToast("common.failed_update", "error")
          return false
        }

        async function saveTD(field: string, value: unknown): Promise<void> {
          await saveTaskField(field, value)
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

        function renderTaskDescription(markdown: string) {
          if (!descPreview) return
          const sanitized = sanitizeClient(String(marked.parse(markdown || "*No description provided.*")))
          const parsedDoc = new DOMParser().parseFromString(sanitized, "text/html")
          descPreview.replaceChildren(...Array.from(parsedDoc.body.childNodes))
          resolveDescriptionTaskReferences(descPreview)
        }

        function enterDescEdit() {
          _descOriginalValue = tdDescription?.value ?? "";
          descEditContainer?.classList.remove("hidden");
          descPreviewContainer?.classList.add("hidden");
          tdDescription?.focus();
        }

        function exitDescEdit(save: boolean) {
          closeTaskReferences()
          descEditContainer?.classList.add("hidden");
          descPreviewContainer?.classList.remove("hidden");
          if (!save && tdDescription) {
            tdDescription.value = _descOriginalValue;
          }
          if (save && descPreview && tdDescription) {
            const rawMarkdown = tdDescription.value;
            try {
              renderTaskDescription(rawMarkdown)
            } catch (e: any) {
              log.error("Markdown render error", e);
              const errDiv = document.createElement("div");
              errDiv.className = "text-red-500";
              errDiv.textContent = `Error rendering markdown: ${String(e?.message ?? e)}`;
              descPreview.replaceChildren(errDiv);
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

        descEditBtnHover?.addEventListener("click", () => enterDescEdit(), { signal: __signal });
        // T9: Only enter edit mode when clicking preview container background, not rendered links/code
        descPreviewContainer?.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          if (target.closest("a, code, pre, img")) return;
          enterDescEdit();
        }, { signal: __signal });
        descSaveBtn?.addEventListener("click", () => exitDescEdit(true), { signal: __signal });
        descCancelBtn?.addEventListener("click", () => exitDescEdit(false), { signal: __signal });
        // T7: Cmd/Ctrl+S shortcut in description edit mode
        tdDescription?.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            exitDescEdit(true);
          }
        }, { signal: __signal });

        // Auto-save on change
        const tdTitleInput = document.getElementById("td-title") as HTMLTextAreaElement;
        if (tdTitleInput) {
          tdTitleInput.addEventListener("blur", (e) =>
            saveTD("title", (e.target as HTMLTextAreaElement).value),
          { signal: __signal });
          tdTitleInput.addEventListener("input", function() {
            this.style.height = "auto";
            this.style.height = this.scrollHeight + "px";
          }, { signal: __signal });
        }
        // Duplicate title blur listener removed — already handled above at line 1066
        document
          .getElementById("td-description")
          ?.addEventListener("blur", (e) =>
            saveTD("description", (e.target as HTMLTextAreaElement).value),
          { signal: __signal });

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
          }, { signal: __signal });

        document.getElementById("td-status")
          ?.addEventListener("change", (e) => {
            const newVal = (e.target as HTMLSelectElement).value;
            saveTD("status", newVal);
            const isDone = newVal === "complete";
            const doneBtn = document.getElementById("td-toggle-done");
            if (doneBtn)
              doneBtn.textContent = isDone
                ? "↩ Mark as Undone"
                : "✓ Mark as Done";
          }, { signal: __signal });
        document
          .getElementById("td-priority")
          ?.addEventListener("change", (e) =>
            saveTD("priority", Number((e.target as HTMLSelectElement).value)),
          { signal: __signal });
        // Eisenhower urgency auto-save
        document
          .getElementById("td-urgency")
          ?.addEventListener("change", (e) =>
            saveTD("urgency", Number((e.target as HTMLSelectElement).value)),
          { signal: __signal });
        // Eisenhower importance auto-save
        document
          .getElementById("td-importance")
          ?.addEventListener("change", (e) =>
            saveTD("importance", Number((e.target as HTMLSelectElement).value)),
          { signal: __signal });
        // Phase 20: task_type auto-save
        document
          .getElementById("td-task-type")
          ?.addEventListener("change", (e) => {
            saveTD("task_type", (e.target as HTMLSelectElement).value);
          }, { signal: __signal });
        // Phase 26: board change auto-save
        document.getElementById("td-area")?.addEventListener("change", (e) => {
          saveTD("area_id", (e.target as HTMLSelectElement).value);
        }, { signal: __signal });
        // Project change auto-save
        document.getElementById("td-project")?.addEventListener("change", async (event) => {
          const select = event.currentTarget as HTMLSelectElement
          const modalSignal = _modalAbortController?.signal
          const projectId = select.value
          select.disabled = true
          const saved = await saveTaskField("project_id", projectId || null)
          if (modalSignal?.aborted) return
          if (saved) select.dataset.savedProject = projectId
          else select.value = select.dataset.savedProject ?? ""
          select.disabled = false
        }, { signal: __signal })

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
              } catch (e) { log.warn("principles-fetch error", e) }
            }
          }
        }, { signal: __signal });

        // Principle change auto-save
        document.getElementById("td-principle")?.addEventListener("change", (e) => {
          saveTD("principle_id", (e.target as HTMLSelectElement).value || null);
        }, { signal: __signal });
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
          }, { signal: __signal });
        // UX2: Keyboard shortcut 'A' to focus assignee dropdown in detail panel
        document.addEventListener("keydown", (e) => {
          const panel = document.getElementById("task-detail-panel");
          if (!panel || panel.style.display === "none") return;
          if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey && singleKeyShortcutsEnabled()) {
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
        }, { signal: __signal });
        document
          .getElementById("td-progress")
          ?.addEventListener("input", (e) => {
            const v = (e.target as HTMLInputElement).value;
            const progEl = document.getElementById("td-progress-value");
            if (progEl) progEl.textContent = `${v}%`;
          }, { signal: __signal });
        document
          .getElementById("td-progress")
          ?.addEventListener("change", (e) =>
            saveTD("progress", Number((e.target as HTMLInputElement).value)),
          { signal: __signal });
        document
          .getElementById("td-color")
          ?.addEventListener("change", (e) =>
            saveTD("color", (e.target as HTMLInputElement).value),
          { signal: __signal });
        document
          .getElementById("td-due-date")
          ?.addEventListener("change", (e) =>
            saveTD("due_date", (e.target as HTMLInputElement).value || null),
          { signal: __signal });
        document
          .getElementById("td-start-date")
          ?.addEventListener("change", (e) =>
            saveTD("start_date", (e.target as HTMLInputElement).value || null),
          { signal: __signal });
        document
          .getElementById("td-end-date")
          ?.addEventListener("change", (e) =>
            saveTD("end_date", (e.target as HTMLInputElement).value || null),
          { signal: __signal });
        document
          .getElementById("td-time-tracked")
          ?.addEventListener("change", (e) =>
            saveTD(
              "time_tracked",
              Number((e.target as HTMLInputElement).value) || 0,
            ),
          { signal: __signal });

        // ───── Labels + Subtasks (extracted) ─────
        const labelsApi = initLabelsAndSubtasks({
          saveTD,
          getCurrentTaskId: () => currentTaskId,
          openTaskDetail,
          signal: __signal,
        })
        const addLabelChip = labelsApi.addLabelChip


        // ───── Custom Fields (extracted) ─────
        const cfApi = initCustomFields({
          saveTD,
          getSettingsFields: () => _settingsFields,
          signal: __signal,
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
                parentResultsDiv.replaceChildren(
                  ...tasks.map((t: Record<string, unknown>) => {
                    const typeIcon =
                      t.task_type === "epic"
                        ? "🎯"
                        : t.task_type === "story"
                          ? "📖"
                          : "✅";
                    const row = document.createElement("div");
                    row.className = "td-parent-result px-3 py-2 text-sm cursor-pointer hover:bg-bg-hover flex items-center gap-2";
                    row.dataset.id = String(t.id ?? "");
                    const iconSpan = document.createElement("span");
                    iconSpan.textContent = typeIcon;
                    const titleSpan = document.createElement("span");
                    titleSpan.className = "truncate";
                    titleSpan.textContent = String(t.title ?? "").slice(0, 60);
                    const typeSpan = document.createElement("span");
                    typeSpan.className = "text-xs text-text-muted ml-auto";
                    typeSpan.textContent = String(t.task_type ?? "task");
                    row.append(iconSpan, titleSpan, typeSpan);
                    return row;
                  }),
                );
                // Click handler for each result
                parentResultsDiv
                  .querySelectorAll(".td-parent-result")
                  .forEach((el) => {
                    el.addEventListener("click", async () => {
                      const newParentId = (el as HTMLElement).dataset.id;
                      if (newParentId) {
                        const modalSignal = _modalAbortController?.signal
                        await saveTD("parent_id", newParentId);
                        if (modalSignal?.aborted) return
                        parentSearchInput.value = "";
                        parentResultsDiv.style.display = "none";
                        // Refresh the panel to show the new parent
                        openTaskDetail(currentTaskId!);
                      }
                    }, { signal: __signal });
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
        }, { signal: __signal });

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
          }, { signal: __signal });

        // Toggle favorite
        document
          .getElementById("td-toggle-favorite")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const search = searchSession
            const generation = detailGeneration
            const btn = document.getElementById(
              "td-toggle-favorite",
            ) as HTMLElement;
            const isFav = btn.textContent?.startsWith("★");
            await saveTD("is_favorite", isFav ? 0 : 1);
            if (search && generation !== detailGeneration) return
            btn.textContent = isFav ? "⭐ Add to Favorites" : "★ Favorited";
          }, { signal: __signal });

        // Duplicate task
        document
          .getElementById("td-duplicate")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const search = searchSession
            const generation = detailGeneration
            const write = search ? beginScopedWrite() : undefined
            const stale = () => search && generation !== detailGeneration
            const toast = document.createElement("div");
            toast.className = "toast";
            try {
              const res = await fetch(
                `${window.__ingress_path || ""}/api/tasks/${currentTaskId}/duplicate`,
                {
                  method: "POST",
                  ...(write ? { signal: write.signal } : {}),
                },
              );
              if (stale()) return
              if (!res.ok) {
                toast.className = "toast error";
                toast.textContent = "Failed to duplicate";
                document.querySelector(".toast-container")?.appendChild(toast);
                setTimeout(() => toast.remove(), 2500);
                return;
              }
              const data = await res.json();
              if (stale()) return
              toast.className = "toast success";
              toast.textContent = `Duplicated → ${data.title}`;
              document.querySelector(".toast-container")?.appendChild(toast);
              setTimeout(() => toast.remove(), 2500);
              if (!search?.queued) void openTaskDetail(data.id)
            } catch {
              if (stale()) return
              toast.className = "toast error";
              toast.textContent = "Network error";
              document.querySelector(".toast-container")?.appendChild(toast);
              setTimeout(() => toast.remove(), 2500);
            } finally {
              write?.finish()
            }
          }, { signal: __signal });

        const askAi = document.querySelector<HTMLButtonElement>("#td-ask-ai")
        askAi?.addEventListener("click", async () => {
          const taskId = currentTaskId
          const signal = _modalAbortController?.signal
          if (!taskId || !signal || signal.aborted || askAi.getAttribute("aria-busy") === "true") return
          askAi.setAttribute("aria-disabled", "true")
          askAi.setAttribute("aria-busy", "true")
          askAi.classList.add("opacity-60")
          document.getElementById("td-ai-response")?.remove()

          function resetButton() {
            if (!askAi) return
            askAi.removeAttribute("aria-disabled")
            askAi.removeAttribute("aria-busy")
            askAi.classList.remove("opacity-60")
          }
          signal.addEventListener("abort", resetButton, { once: true })
          try {
            const result = await askAIForTask(taskId, signal)
            if (signal.aborted || currentTaskId !== taskId) return
            if (result.source === "ha-assist") {
              const response = document.createElement("div")
              response.id = "td-ai-response"
              response.className = "mt-2 p-3 bg-accent/10 border border-accent/20 rounded-md text-xs text-text-secondary leading-relaxed"
              const header = document.createElement("div")
              header.className = "flex justify-between items-center mb-1.5"
              const title = document.createElement("strong")
              title.className = "text-accent text-[11px]"
              title.textContent = "AI Response"
              const dismiss = document.createElement("button")
              dismiss.type = "button"
              dismiss.id = "td-ai-dismiss"
              dismiss.className = "text-text-muted hover:text-text-primary text-xs px-1"
              dismiss.setAttribute("aria-label", "Dismiss AI response")
              dismiss.textContent = "×"
              header.append(title, dismiss)
              const body = document.createElement("div")
              body.className = "whitespace-pre-wrap"
              body.textContent = result.response
              response.replaceChildren(header, body)
              askAi.parentElement?.after(response)
              dismiss.addEventListener("click", () => response.remove(), { signal })
            }
          } catch (err) {
            if (signal.aborted || currentTaskId !== taskId) return
            log.error("AI context error", err)
            showToast("settings.ai_handoff_context_failed", "error")
          } finally {
            signal.removeEventListener("abort", resetButton)
            if (!signal.aborted && currentTaskId === taskId) resetButton()
          }
        }, { signal: __signal })

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
            const taskId = currentTaskId
            if (!taskId) return
            const search = searchSession
            const generation = detailGeneration
            const stale = () => search && generation !== detailGeneration
            const ok = await confirmDialog({
              message: "This task will be permanently deleted.",
              variant: "danger",
              confirmText: "Delete Task",
              title: "Delete Task",
              ...(search ? { signal: search.lifetime.signal } : {}),
            });
            if (!ok || stale() || taskId !== currentTaskId) return
            const scopedWrite = beginScopedWrite()
            try {
              const res = await fetch(
                `${window.__ingress_path || ""}/api/tasks/${taskId}`,
                {
                  method: "DELETE",
                  ...(scopedWrite ? { signal: scopedWrite.signal } : {}),
                },
              );
              if (stale()) return
              // Treat 204 (deleted) and 404 (already gone) as success
              if (res.ok || res.status === 404) {
                const deferred = deferral.removing(taskId)
                closeTD("discard")
                if (!deferred && !scopedWrite) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "task-deleted" } }));
              } else if (search) {
                const { showToast } = await import("@lib/toast")
                if (!stale()) showToast("Couldn’t delete the task.", "error")
              }
            } catch {
              if (stale()) return
              // Network error — still close and refresh to re-sync
              closeTD("discard")
              if (!scopedWrite) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "task-delete-fallback" } }));
            } finally {
              scopedWrite?.finish()
            }
          }, { signal: __signal });

        let commentAttempt: { taskId: string, draft: string, key: string } | undefined
        commentButton?.addEventListener("click", async () => {
          const taskId = currentTaskId
          const signal = _modalAbortController?.signal
          const initialComments = commentsReady
          const draft = commentInput?.value
          if (!taskId || !signal || !commentInput || !draft?.trim()) return

          closeTaskReferences()
          commentButton.disabled = true
          commentError?.setAttribute("hidden", "")
          let participantDenied = false
          let mentionFailure: Awaited<ReturnType<typeof readCommentMentionProblem>>
          const mentionHeaders = commentMentionWriteHeaders(draft)
          const hasMentions = Boolean(mentionHeaders[commentMentionContextHeader])
          if (hasMentions && (commentAttempt?.taskId !== taskId || commentAttempt.draft !== draft)) {
            commentAttempt = { taskId, draft, key: `${Date.now()}.${crypto.randomUUID()}` }
          }
          try {
            const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
              method: "POST",
              headers: { "content-type": "application/json", ...mentionHeaders,
                ...(hasMentions && commentAttempt ? { [commentAttemptHeader]: commentAttempt.key } : {}) },
              body: JSON.stringify({ content: draft }),
              signal,
            })
            if (!response.ok) {
              participantDenied = await isActiveParticipantProblem(response)
              mentionFailure = await readCommentMentionProblem(response)
              throw new Error("Comment request failed")
            }
            const receipt: unknown = await response.json()
            if (!receipt || typeof receipt !== "object" || !("id" in receipt) ||
              typeof receipt.id !== "number" || !Number.isSafeInteger(receipt.id) || receipt.id < 1) {
              throw new Error("Comment response did not include a valid receipt")
            }
            notifyInactivityTaskChanged(taskId)
            if (signal.aborted) return
            if (commentInput.value === draft) commentInput.value = ""
            commentAttempt = undefined
            const { id } = receipt
            await initialComments
            if (!signal.aborted) await loadComments(taskId, signal, null, id)
          } catch {
            if (!signal.aborted && commentError) {
              commentError.textContent = (participantDenied ? commentError.dataset.participantRequired
                : mentionFailure === "context" ? commentError.dataset.mentionContextChanged
                : mentionFailure ? commentError.dataset.mentionFailed : commentError.dataset.failed) ?? ""
              commentError.removeAttribute("hidden")
              if ((participantDenied || mentionFailure) && [document.body, commentButton].includes(document.activeElement as HTMLElement)) commentInput.focus()
            }
          } finally {
            if (!signal.aborted) commentButton.disabled = false
          }
        }, { signal: __signal })

        document.getElementById("td-copy-link")?.addEventListener("click", async () => {
          if (!currentTaskId) return
          const taskId = currentTaskId
          const link = buildTaskPermalink(taskId)
          const copied = await copyToClipboard(link)
          if (__signal.aborted || currentTaskId !== taskId) return
          if (copied) {
            copyFallback?.setAttribute("hidden", "")
            const { showToast } = await import("@lib/toast")
            showToast("task_modal.link_copied", "success")
          } else if (copyFallback && copyValue) {
            copyFallback.removeAttribute("hidden")
            copyValue.value = link
            copyValue.focus()
            copyValue.select()
          }
        }, { signal: __signal })

        // Close
        tdClose?.addEventListener("click", () => closeTD(), { signal: __signal })
        tdOverlay?.addEventListener("click", (e) => {
          if (e.target === tdOverlay) closeTD("discard")
        }, { signal: __signal });

        function checkTaskLocation(fromHistory = false) {
          if (waitForDetailWrites(() => checkTaskLocation(fromHistory))) return
          const url = new URL(window.location.href)
          const taskId = ticketIdFromPath(url.pathname, window.__ingress_path) ?? getLegacyTaskId(url.hash) ?? url.searchParams.get("open")
          const commentTarget = url.searchParams.get("comment")
          if (taskId === null) closeTD("discard", false)
          else if (tdOverlay.dataset.suppressUrlOpen !== "true" &&
            (taskId !== currentTaskId || commentTarget !== currentCommentTarget || !tdOverlay.classList.contains("active"))) {
            void openTaskDetail(taskId, commentTarget, undefined, false)
            if (fromHistory) {
              const generation = detailGeneration
              // The browser can restore a Settings anchor after popstate finishes.
              requestAnimationFrame(() => {
                if (!__signal.aborted && generation === detailGeneration && tdOverlay.classList.contains("active") &&
                    !tdOverlay.contains(document.activeElement)) tdClose?.focus({ preventScroll: true })
              })
            }
          }
        }
        const discardSearchDetail = () => { if (searchSession) closeTD("history") }
        window.addEventListener("popstate", discardSearchDetail, { capture: true, signal: __signal })
        window.addEventListener("hashchange", discardSearchDetail, { capture: true, signal: __signal })
        window.addEventListener("pagehide", discardSearchDetail, { signal: __signal })
        window.addEventListener("popstate", () => checkTaskLocation(true), { signal: __signal })
        window.addEventListener("meitheal:ticket-history", () => checkTaskLocation(true), { signal: __signal })
        window.addEventListener("hashchange", () => checkTaskLocation(true), { signal: __signal })
        checkTaskLocation()

        // Expose openTaskDetail globally for cross-page use (table, index new-task flow)
        window.openTaskDetail = openTaskDetail;
        const openPinnedTaskDetail = (taskId: string, reconcile: () => void) => {
          if (!tdOverlay.isConnected || __signal.aborted || tdOverlay.classList.contains("active")) return
          pinnedSession = { reconcile, dirty: false, pending: 0 }
          void openTaskDetail(taskId)
        }
        window.openPinnedTaskDetail = openPinnedTaskDetail
        __signal.addEventListener("abort", () => {
          if (window.openTaskDetail === openTaskDetail) delete window.openTaskDetail
          if (window.openPinnedTaskDetail === openPinnedTaskDetail) delete window.openPinnedTaskDetail
        }, { once: true })

        // Delegated click → open task detail for any task element
        // P1-3: Also handles keyboard activation (Enter/Space) for a11y
        function handleTaskActivation(event: Event) {
          const target = event.target
          if (event.defaultPrevented || !(target instanceof Element)) return
          const link = target.closest<HTMLAnchorElement>("a[data-task-detail-link]")
          if (link) {
            if (!(event instanceof MouseEvent) || event.type !== "click" || event.button !== 0 ||
                event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
                (link.target && link.target !== "_self") || link.hasAttribute("download")) return
            const id = link.dataset.taskDetailLink
            if (!id) return
            event.preventDefault()
            void openTaskDetail(id, new URL(link.href).searchParams.get("comment"))
            return
          }
          if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return
          if (target.closest("button, a, input, select, textarea, .task-actions, .action-btn")) return
          if (target instanceof HTMLElement && target.isContentEditable) return

          const taskEl = target.closest<HTMLElement>(
            ".task-item, .kanban-card, .bento-card, tr[data-id], [data-task-id]",
          )
          const taskId = taskEl && (taskEl.dataset.id || taskEl.dataset.taskId)
          if (taskEl && taskId) {
            event.preventDefault()
            event.stopPropagation()
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
        document.body.addEventListener("click", event => {
          if (event.target instanceof Element && event.target.closest("a[data-task-detail-link]")) handleTaskActivation(event)
        }, { signal: __signal, capture: true })
        document.body.addEventListener("click", handleTaskActivation, {
          signal: __signal,
        });
        // P1-3: Keyboard activation for kanban cards and task items
        document.body.addEventListener("keydown", handleTaskActivation, {
          signal: __signal,
        });

        // === Command Palette (extracted) ===
        initCommandPalette({ openTaskDetail, __signal })
        });

