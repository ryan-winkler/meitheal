import { currentTaskApiContext } from "./task-api"
import { deleteVersionedTask, saveVersionedTask, sameTaskApiContext, taskRecordVersion } from "./task-api-client"
        import { askAIForTask } from "@domains/ai/ai-context-service";
        import { createClientLogger } from "@lib/client-logger";
        import { copyToClipboard } from "@lib/clipboard"
        import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
        import {
          buildTaskPermalink, findKanbanDetailFocus, getLegacyTaskId, type SearchDetailDismissal, type SearchDetailHandoff,
        } from "@lib/task-detail-handoff"
        import { buildIngressPagePath } from "@lib/page-shell-links"
        import { restoreTaskBackgroundUrl, sameTaskLocator, taskDetailPath, ticketIdFromPath, taskBackgroundUrl } from "@lib/task-page-url"
        import { formatTicketKey, parseTicketKey } from "@lib/ticket-key"

        const log = createClientLogger("tasks", "detail-modal");
        import { saveAttachment } from "@domains/offline/offline-store";
        import { confirmDialog } from "@lib/confirm-dialog";
        import { pageLifecycle } from "@lib/page-lifecycle";
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
        import { saveNavigationState } from "@lib/ingress-state-persistence"
        import { hasPriorityOverlay } from "@lib/layout-shortcuts-controller"
        import { lockTaskStatusWrite, taskApi, type AssigneeDirectory } from "@lib/task-api-client"
        import { initTaskDetailLayoutEditor, initTicketSectionOrder } from "@lib/task-detail-layout-controller"
        import { assigneeFallback } from "@lib/task-assignee-display"
        import { isDoneStatus, normalizeStatus } from "@lib/status-config"

        // Use lifecycle signal for all global listeners in this module
        pageLifecycle.onPageLoad(() => {
          const __signal = pageLifecycle.signal;

          // === Task Detail Panel ===
          const tdOverlay = document.getElementById(
            "task-detail-overlay",
          ) as HTMLDivElement;
        if (!tdOverlay || tdOverlay.dataset.namedBoard || tdOverlay.dataset.detailController === "ready") return
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
        let boardWithheld = false
        let boardRevoked = false
        document.addEventListener("meitheal:board-hidden", () => {
          boardWithheld = true
          tdOverlay.hidden = true
          tdOverlay.inert = true
          _modalAbortController?.abort()
          closeTaskReferences()
        }, { signal: __signal })
        document.addEventListener("meitheal:board-revoked", event => {
          const boardId = (event as CustomEvent<{ boardId?: string }>).detail?.boardId
          if (boardId && boardId !== currentTaskApiContext()?.boardId) return
          boardRevoked = true
          boardWithheld = true
          _modalAbortController?.abort()
          detailGeneration++
          descriptionRenderSequence++
          searchSession?.lifetime.abort()
          searchSession?.handoff.onDismiss("history")
          searchSession = undefined
          pinnedSession = undefined
          currentTaskId = null
          currentTaskVersion = null
          currentTaskActions.clear()
          currentTicketKey = null
          sessionTicketId = null
          currentCommentTarget = null
          taskLoaded = false
          resumeLoadedTask = undefined
          pendingDescriptionSave = undefined
          queuedDescriptionTransition = undefined
          hasChecklistTextDraft = undefined
          taskSaveQueues.clear()
          pendingAreaWrites.clear()
          commentAttempt = undefined
          _descOriginalValue = ""
          _settingsFields = []
          _previouslyFocused = null
          if (_descSavedTimer !== null) clearTimeout(_descSavedTimer)
          clearTimeout(parentSearchTimer)
          closeTaskReferences()
          deferral.opening(false)
          pins.opening()
          for (const field of tdOverlay.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")) field.value = ""
          tdOverlay.hidden = true
          tdOverlay.inert = true
          tdOverlay.classList.remove("active", "closing")
          delete tdOverlay.dataset.openTaskId
          tdOverlay.replaceChildren()
          tdOverlay.remove()
          document.body.style.overflow = ""
          document.body.classList.remove("has-docked-inspector")
        }, { signal: __signal })
        document.addEventListener("meitheal:board-verified", () => {
          if (boardRevoked) return
          boardWithheld = false
          // A new confirmation after unchanged verification gets a fresh lifetime;
          // the cancelled confirmation and its original request remain aborted.
          if (currentTaskId && taskLoaded && _modalAbortController?.signal.aborted) {
            _modalAbortController = new AbortController()
            resumeLoadedTask?.()
          }
          tdOverlay.hidden = false
          tdOverlay.inert = false
        }, { signal: __signal })
        let detailGeneration = 0
        const deferral = initModalDeferral(tdOverlay, __signal)
        const pins = initModalTaskPin(tdOverlay, __signal, () => { if (pinnedSession) pinnedSession.dirty = true })
        const closeTaskReferences = initModalTaskReferences(tdOverlay, __signal)
        const tdClose = document.getElementById("td-close")
        const tdPanel = document.getElementById("task-detail-panel")
        const tdHeading = document.getElementById("td-task-heading")
        const tdActions = document.getElementById("td-task-actions")
        const tdTitleInput = tdPanel?.querySelector<HTMLTextAreaElement>("#td-title")
        const statusSelect = document.querySelector<HTMLSelectElement>("#td-status")
        const doneButton = document.querySelector<HTMLButtonElement>("#td-toggle-done")
        const deleteButton = document.querySelector<HTMLButtonElement>("#td-delete")
        const tdError = document.getElementById("td-load-error")
        const copyFallback = document.getElementById("td-copy-link-fallback")
        const copyValue = document.querySelector<HTMLInputElement>("#td-copy-link-value")
        const commentInput = document.querySelector<HTMLTextAreaElement>("#td-comment-input")
        const commentButton = document.querySelector<HTMLButtonElement>("#td-comment-submit")
        const commentError = document.getElementById("td-comment-error")
        let currentTaskId: string | null = null;
        let currentTaskVersion: number | null = null
        const currentTaskActions = new Set<string>()
        let taskSaveConflict = false
        const taskSaveQueues = new Map<string, Promise<void>>()
        let sessionTicketId: string | null = null
        let currentTicketKey: string | null = null
        let pendingDescriptionSave: Promise<boolean> | undefined
        let hasChecklistTextDraft: (() => boolean) | undefined
        let queuedDescriptionTransition: (() => void) | undefined
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
        let drawerEntry = 0
        tdOverlay.dataset.ticketHistorySession = drawerSession

        const dockMedia = window.matchMedia("(min-width: 1440px)")
        const scroller = document.getElementById("td-loaded-content")
        const sections = document.getElementById("td-sections")!
        const updateSectionOrder = initTicketSectionOrder(sections, __signal)
        const focusToggle = document.querySelector<HTMLButtonElement>("#td-toggle-focus")
        const layoutToggle = document.querySelector<HTMLButtonElement>("#td-toggle-layout")
        const layoutPanel = document.getElementById("td-layout-panel")
        const loadedActions = tdOverlay.querySelector<HTMLElement>("[data-td-loaded-actions]")
        let layoutEditorMounted = false
        let layoutScrollTop = 0
        let focusMode = false
        let taskLoaded = false
        let resumeLoadedTask: (() => void) | undefined

        function setInspectorAriaLabel(label: string) {
          tdOverlay.setAttribute("aria-label", label)
          tdPanel?.setAttribute("aria-label", label)
        }

        function syncInspectorDockMode() {
          const isOpen = tdOverlay.classList.contains("active") && !tdOverlay.classList.contains("closing")
          const docked = isOpen && !focusMode && dockMedia.matches
          document.body.classList.toggle("has-docked-inspector", docked)
          tdOverlay.toggleAttribute("data-focus-mode", focusMode)
          tdPanel?.setAttribute("role", docked ? "region" : "dialog")
          if (docked) tdPanel?.removeAttribute("aria-modal")
          else tdPanel?.setAttribute("aria-modal", "true")
          document.body.style.overflow = isOpen && !docked ? "hidden" : ""
          if (loadedActions) loadedActions.hidden = !taskLoaded && !focusMode
          if (layoutToggle) layoutToggle.hidden = !taskLoaded
          syncTaskActionControls()
          const label = focusToggle?.querySelector("span")
          if (label && focusToggle) {
            label.textContent = (focusMode ? focusToggle.dataset.exitLabel : focusToggle.dataset.enterLabel) ?? ""
          }
        }

        function resizeTitle(): void {
          if (!tdTitleInput?.getClientRects().length) return
          tdTitleInput.style.height = "auto"
          tdTitleInput.style.height = `${tdTitleInput.scrollHeight + 2}px`
        }

        function setFocusMode(expanded: boolean): void {
          const viewport = scroller?.getBoundingClientRect()
          const isVisible = (element: Element) => {
            const rect = element.getBoundingClientRect()
            return viewport && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
          }
          const active = document.activeElement
          const anchor = active && scroller?.contains(active) && isVisible(active) ? active :
            [...sections.children].find(isVisible)
          const offset = anchor && viewport ? anchor.getBoundingClientRect().top - viewport.top : 0
          focusMode = expanded
          tdOverlay.setAttribute("data-focus-used", "")
          syncInspectorDockMode()
          resizeTitle()
          if (scroller && anchor) {
            const rect = anchor.getBoundingClientRect()
            const view = scroller.getBoundingClientRect()
            const margin = Math.min(32, rect.height, view.height)
            const usableOffset = Math.max(margin - rect.height, Math.min(offset, view.height - margin))
            scroller.scrollTop += rect.top - view.top - usableOffset
          }
          if (!tdPanel?.contains(document.activeElement)) focusToggle?.focus({ preventScroll: true })
        }

        // A pointer toggle can be used mid-edit without blurring the active input.
        focusToggle?.addEventListener("mousedown", event => {
          const active = document.activeElement
          if (event.button === 0 && scroller?.contains(active) && active?.matches("input, textarea, [contenteditable]")) {
            event.preventDefault()
          }
        }, { signal: __signal })
        focusToggle?.addEventListener("click", () => setFocusMode(!focusMode), { signal: __signal })

        function setLayoutPanel(open: boolean): void {
          if (!layoutPanel || !layoutToggle || !scroller) return
          if (open) {
            layoutScrollTop = scroller.scrollTop
            const editor = layoutPanel.querySelector<HTMLElement>("[data-task-layout-editor]")
            if (editor && !layoutEditorMounted) {
              initTaskDetailLayoutEditor(editor, __signal)
              layoutEditorMounted = true
            }
          }
          const wasFocused = layoutPanel.contains(document.activeElement)
          layoutPanel.hidden = !open
          layoutToggle.setAttribute("aria-expanded", String(open))
          scroller.scrollTop = open ? 0 : layoutScrollTop
          if (!open && wasFocused) layoutToggle.focus({ preventScroll: true })
        }

        layoutToggle?.addEventListener("click", () => setLayoutPanel(Boolean(layoutPanel?.hidden)), { signal: __signal })
        dockMedia.addEventListener("change", syncInspectorDockMode, { signal: __signal })
        window.addEventListener("resize", resizeTitle, { passive: true, signal: __signal })
        __signal.addEventListener("abort", () => {
          document.body.classList.remove("has-docked-inspector")
          tdOverlay.removeAttribute("data-focus-mode")
          tdOverlay.removeAttribute("data-focus-used")
          tdPanel?.setAttribute("role", "dialog")
          tdPanel?.setAttribute("aria-modal", "true")
        }, { once: true })

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
            const locator = currentTicketKey !== null && sameTaskLocator(taskId, currentTaskId, currentTicketKey) ? currentTicketKey : taskId
            const target = new URL(buildIngressPagePath(taskDetailPath(locator)), url.origin)
            if (commentTarget !== null) target.searchParams.set("comment", commentTarget)
            if (target.href === url.href) return
            if (ticket !== null) {
              history.replaceState(history.state, "", target)
              saveNavigationState()
              return
            }
            const legacy = url.searchParams.has("open") || url.searchParams.has("ticket") || getLegacyTaskId(url.hash) !== null
            url.searchParams.delete("open")
            url.searchParams.delete("ticket")
            url.searchParams.delete("comment")
            if (getLegacyTaskId(url.hash) !== null) url.hash = ""
            const state = { ...history.state, ticketDrawer: { returnTo: url.href, session: drawerSession, pushed: !legacy && !replace } }
            if (legacy || replace) history.replaceState(state, "", target)
            else {
              const ticketBackground = `${drawerSession}-${++drawerEntry}`
              history.replaceState({ ...history.state, ticketBackground }, "")
              history.pushState({ ...state, ticketBackground }, "", target)
            }
            saveNavigationState()
          } else if (ticket !== null) {
            if (history.state?.ticketDrawer?.pushed) history.back()
            else {
              history.replaceState(history.state, "", taskBackgroundUrl(url))
              saveNavigationState()
            }
          } else if (url.searchParams.has("open") || url.searchParams.has("ticket") || getLegacyTaskId(url.hash) !== null) {
            url.searchParams.delete("open")
            url.searchParams.delete("ticket")
            url.searchParams.delete("comment")
            if (getLegacyTaskId(url.hash) !== null) url.hash = ""
            history.replaceState(history.state, "", url)
            saveNavigationState()
          }
        }

        const pendingAreaWrites = new Map<string, Promise<string | null>>()
        let changedAreaTask: string | null = null

        function reconcileAreaGrouping() {
          if (!changedAreaTask || __signal.aborted) return
          changedAreaTask = null
          document.dispatchEvent(new CustomEvent("kanban:detail-changed", { detail: "area" }))
        }

        let epicGroupingDirty = false
        function reconcileEpicGrouping() {
          if (!epicGroupingDirty || __signal.aborted) return
          epicGroupingDirty = false
          document.dispatchEvent(new Event("meitheal:task-hierarchy-changed"))
        }

        function waitForDescriptionWrite(next: () => void): boolean {
          const dirty = currentTaskId && !descEditContainer?.classList.contains("hidden") &&
            tdDescription.value !== _descOriginalValue
          if (!pendingDescriptionSave && !dirty) return false
          if (dirty && _isPopulating) {
            queuedDescriptionTransition = next
            return true
          }
          const generation = detailGeneration
          const write = pendingDescriptionSave ?? exitDescEdit(true)
          void write.then(saved => {
            if (saved && !__signal.aborted && generation === detailGeneration) next()
          })
          return true
        }

        function waitForChecklistTextWrite(next: () => void): boolean {
          if (!currentTaskId) return false
          const active = document.activeElement
          if (active instanceof HTMLTextAreaElement && active.closest("#td-checklists")) active.blur()
          if (!hasChecklistTextDraft?.()) return false
          const write = pendingChecklistSave(currentTaskId)
          if (!write) {
            document.getElementById("td-checklist-recover")?.focus()
            return true
          }
          const generation = detailGeneration
          void write.then(saved => {
            if (saved && !__signal.aborted && !boardWithheld && generation === detailGeneration) next()
          })
          return true
        }

        function closeTD(reason: SearchDetailDismissal = "dismiss", updateLocation = true) {
          const search = searchSession
          const immediate = reason === "history" && Boolean(search)
          if (!tdOverlay?.classList.contains("active") || (!immediate && tdOverlay.classList.contains("closing"))) return
          if (!immediate && waitForDetailWrites(() => closeTD(reason, updateLocation))) return
          if (waitForDescriptionWrite(() => closeTD(reason, updateLocation))) return
          if (!immediate && waitForChecklistTextWrite(() => closeTD(reason, updateLocation))) return
          const closing = ++detailGeneration
          const previousCard = _previouslyFocused?.closest<HTMLElement>(".kanban-card")
          const previousDay = _previouslyFocused?.closest<HTMLElement>(".cal-cell")?.dataset.date
          const previousCompletion = _previouslyFocused instanceof HTMLAnchorElement &&
            _previouslyFocused.hasAttribute("data-today-completion") ? _previouslyFocused.dataset.taskDetailLink : undefined
          closeTaskReferences()
          search?.lifetime.abort()
          deferral.opening(false)
          pins.opening()
          // Abort any in-flight fetches
          if (_modalAbortController) { _modalAbortController.abort(); _modalAbortController = null; }
          currentTaskId = null;
          hasChecklistTextDraft = undefined
          document.dispatchEvent(new CustomEvent("meitheal:ha-location-task"))
          sessionTicketId = null
          currentTicketKey = null
          pendingDescriptionSave = undefined
          queuedDescriptionTransition = undefined
          taskLoaded = false
          resumeLoadedTask = undefined
          currentCommentTarget = null
          delete tdOverlay.dataset.openTaskId
          if (updateLocation) setTaskLocation(null)

          const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

          const finishClose = () => {
            if (closing !== detailGeneration || currentTaskId !== null || !tdOverlay.classList.contains("active")) return
            tdOverlay.classList.remove("active", "closing");
            focusMode = false
            tdOverlay.removeAttribute("data-focus-used")
            if (layoutPanel && !layoutPanel.hidden) setLayoutPanel(false)
            syncInspectorDockMode();
            // P3-4: Restore focus to the element that triggered the panel
            const kanban = document.getElementById("kanban-board")
            const origin = _previouslyFocused?.isConnected ? _previouslyFocused
              : _previouslyFocused?.id ? document.getElementById(_previouslyFocused.id)
              : previousCard && kanban && _previouslyFocused ? findKanbanDetailFocus(kanban, _previouslyFocused)
              : previousDay ? document.querySelector<HTMLElement>(`.cal-cell[data-date="${CSS.escape(previousDay)}"]`) ??
                document.querySelector<HTMLElement>("#calendar-shell .cal-today-btn")
              : previousCompletion ? Array.from(document.querySelectorAll<HTMLElement>(
                `.today-section__list a[data-task-detail-link="${CSS.escape(previousCompletion)}"]`,
              )).find(link => !link.closest("[hidden], [inert], .filtered-out")) : null
            if (!search && origin instanceof HTMLElement && origin !== document.body &&
                !origin.closest("[hidden], [inert], .filtered-out")) {
              origin.focus()
            } else if (!search) {
              document.querySelector<HTMLElement>('[data-view-tab][aria-current="page"], #triage-heading, #deferred-heading, #pinned-heading, #today-filter-status')?.focus()
            }
            _previouslyFocused = null
            const closed = pinnedSession
            pinnedSession = undefined
            searchSession = undefined
            const deferralChanged = deferral.closed(Boolean(closed), Boolean(search))
            if (closed && (closed.dirty || deferralChanged)) closed.reconcile()
            if (search?.dirty && !search.pending && !deferralChanged) deferral.reconcileSearch()
            search?.handoff.onDismiss(reason)
            reconcileAreaGrouping()
            reconcileEpicGrouping()
          };

          if (reducedMotion || immediate || focusMode || document.body.classList.contains("has-docked-inspector")) {
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

        function statusAllowed(next: string): boolean {
          const previous = statusSelect?.dataset.savedStatus ?? "pending"
          const laneStatus = statusSelect?.querySelector<HTMLOptionElement>(`option[value="${CSS.escape(next)}"]`)?.dataset.statusMeaning ?? next
          return currentTaskActions.has("edit") &&
            (!(isDoneStatus(laneStatus) || isDoneStatus(previous)) || currentTaskActions.has("complete")) &&
            (normalizeStatus(laneStatus) !== "archived" || currentTaskActions.has("delete"))
        }

        function syncTaskActionControls() {
          const editable = taskLoaded && !_isPopulating && currentTaskActions.has("edit")
          if (tdTitleInput) tdTitleInput.readOnly = !editable
          // Promotion saves through the task, so it waits for Details to finish loading.
          const promote = document.getElementById("td-toggle-promote") as HTMLButtonElement | null
          if (promote && promote.getAttribute("aria-busy") !== "true") promote.disabled = !editable
          if (statusSelect) {
            statusSelect.disabled = !editable
            for (const option of statusSelect.options) option.disabled = !statusAllowed(option.value)
          }
          if (doneButton) {
            doneButton.hidden = !taskLoaded || !currentTaskActions.has("complete")
            doneButton.disabled = !editable || !currentTaskActions.has("complete")
          }
          if (deleteButton) {
            deleteButton.hidden = !taskLoaded || !currentTaskActions.has("delete")
            deleteButton.disabled = _isPopulating || deleteButton.hidden
          }
        }

        function setStatusBusy(busy: boolean) {
          for (const control of [statusSelect, doneButton]) {
            if (busy) control?.setAttribute("aria-disabled", "true")
            else control?.removeAttribute("aria-disabled")
          }
        }

        function renderSavedStatus(status: string) {
          if (statusSelect) {
            statusSelect.value = status
            statusSelect.dataset.savedStatus = status
          }
          if (doneButton) doneButton.textContent = isDoneStatus(status) ? "Mark as Undone" : "Mark as Done"
          syncTaskActionControls()
        }

        document.addEventListener("meitheal:today-status-committed", event => {
          const { id, status } = (event as CustomEvent<{ id: string; status: string }>).detail
          if (currentTaskId === id) renderSavedStatus(status)
        }, { signal: __signal })

        async function openTaskDetail(taskId: string, commentTarget: string | null = null, search?: SearchDetailHandoff, updateLocation = true) {
          if (boardWithheld) return
          if (!tdOverlay?.isConnected || __signal.aborted) return
          const newSession = !tdOverlay.classList.contains("active")
          if (search && !newSession) {
            search.onDismiss("history")
            return
          }
          const requestedTicket = parseTicketKey(taskId)
          const sameTicket = !newSession && sameTaskLocator(taskId, sessionTicketId ?? currentTaskId, currentTicketKey)
          if (!sameTicket && waitForDescriptionWrite(() => {
            void openTaskDetail(taskId, commentTarget, search, updateLocation)
          })) return
          if (sameTicket && pendingDescriptionSave) {
            const generation = detailGeneration
            await pendingDescriptionSave
            if (__signal.aborted || generation !== detailGeneration) return
            return openTaskDetail(taskId, commentTarget, search, updateLocation)
          }
          if (waitForDetailWrites(() => { void openTaskDetail(taskId, commentTarget, search, updateLocation) })) return
          if (waitForChecklistTextWrite(() => { void openTaskDetail(taskId, commentTarget, search, updateLocation) })) return
          if (search) searchSession = { handoff: search, lifetime: new AbortController(), dirty: false, pending: 0 }
          detailGeneration++
          const loadedGeneration = detailGeneration
          resumeLoadedTask = undefined
          closeTaskReferences()
          deferral.opening(newSession)
          pins.opening()
          // P3-4: Store focus origin for restore on close
          if (newSession) _previouslyFocused = search ? null : document.activeElement
          document.dispatchEvent(new CustomEvent("meitheal:ha-location-task"))
          currentTaskId = taskId
          hasChecklistTextDraft = undefined
          currentTaskVersion = null
          currentTaskActions.clear()
          if (!sameTicket) {
            sessionTicketId = null
            currentTicketKey = null
            pendingDescriptionSave = undefined
          }
          taskLoaded = false
          currentCommentTarget = commentTarget
          tdOverlay.dataset.openTaskId = taskId
          if (updateLocation) setTaskLocation(taskId, false, commentTarget)
          if (_modalAbortController) _modalAbortController.abort();
          _modalAbortController = new AbortController();
          const modalSignal = _modalAbortController.signal
          document.getElementById("td-ai-response")?.remove()
          _isPopulating = true;
          syncTaskActionControls()
          statusSelect?.removeAttribute("data-saved-status")
          setStatusBusy(false)
          const areaField = document.querySelector<HTMLSelectElement>("#td-area")
          const ticketKey = formatTicketKey(requestedTicket)
          const areaWriteAtOpen = pendingAreaWrites.get(taskId) ?? (ticketKey ? pendingAreaWrites.get(ticketKey) : undefined)
          let areaFieldReady = false
          if (areaField) {
            areaField.disabled = true
            areaField.replaceChildren()
          }
          const projectField = document.querySelector<HTMLSelectElement>("#td-project")
          let projectFieldReady = false
          if (projectField) projectField.disabled = true
          const assignSelect = document.querySelector<HTMLSelectElement>("#td-assigned-to")
          let assigneeReady = false
          if (assignSelect) assignSelect.disabled = true
          if (!sameTicket) {
            focusMode = false
            tdOverlay.removeAttribute("data-focus-used")
            if (layoutPanel && !layoutPanel.hidden) setLayoutPanel(false)
            for (const section of sections.querySelectorAll<HTMLDetailsElement>(":scope > details")) {
              section.open = section.dataset.layoutItem !== "activity"
            }
            updateSectionOrder()
            if (scroller) scroller.scrollTop = 0
          }
          if (commentTarget !== null) {
            const comments = sections.querySelector<HTMLDetailsElement>("#td-section-comments")
            if (comments) comments.open = true
          }
          tdOverlay.classList.remove("closing")
          tdOverlay.classList.add("active");
          syncInspectorDockMode();
          tdClose?.focus()
          reconcileAreaGrouping()
          // Set dynamic aria-label for screen readers
          setInspectorAriaLabel(`Task detail: loading...`);
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
            setInspectorAriaLabel("Task detail")
            if (tdError) {
              tdError.textContent = (unavailable ? tdError.dataset.unavailable : tdError.dataset.failed) ?? null
              tdError.hidden = false
            }
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
            if (areaWriteAtOpen) {
              await areaWriteAtOpen
              if (modalSignal.aborted) return
            }
            const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { // nosemgrep
              signal: modalSignal,
              ...(pendingChecklist || areaWriteAtOpen ? { cache: "no-store" } : {}),
            })
            if (modalSignal.aborted) return
            if (!res.ok) {
              showTaskError([401, 403, 404].includes(res.status))
              return
            }
            const t = (await res.json()) as Record<string, unknown>
            if (modalSignal.aborted) return
            if (!t.id || (requestedTicket !== null && requestedTicket !== Number(t.ticket_number))) {
              showTaskError(false)
              return
            }
            if (Array.isArray(t.actions)) {
              for (const action of t.actions) {
                if (action === "edit" || action === "complete" || action === "delete") currentTaskActions.add(action)
              }
            }
            taskId = String(t.id)
            currentTaskId = taskId
            tdOverlay.dataset.openTaskId = taskId
            currentTaskVersion = taskRecordVersion(t)
            taskSaveConflict = false
            document.getElementById("td-write-conflict")?.remove()
            document.dispatchEvent(new CustomEvent("meitheal:ha-location-task", { detail: taskId }))
            sessionTicketId = taskId
            currentTicketKey = typeof t.ticket_key === "string" ? t.ticket_key : null
            setTaskLocation(taskId, true, commentTarget)

            // Start independent inspector reads together. Each field keeps its own fallback.
            const requestOptions = { signal: modalSignal }
            const lanes = fetch("/api/lanes", requestOptions)
            const backlogModeSetting = fetch("/api/settings?key=backlog_mode", requestOptions)
            const areas = areaField ? fetch("/api/areas", requestOptions) : null
            const projectRead = projectField ? fetch("/api/projects", requestOptions) : null
            const pillars = fetch("/api/pillars", requestOptions)
            if (assignSelect) {
              const assigned = String(t.assigned_to ?? "")
              assignSelect.replaceChildren(new Option("Unassigned", ""))
              if (assigned) assignSelect.add(new Option("Loading assignee…", assigned, true, true))
              const renderAssignees = (directory: AssigneeDirectory | null) => {
                if (modalSignal.aborted || currentTaskId !== taskId) return
                const options = [new Option(directory ? "Unassigned" : "Could not load assignees", "")]
                for (const user of directory?.users ?? []) {
                  const name = user.display_name || user.name || user.id
                  options.push(new Option(name + (user.kind === "agent" ? " (AI agent)" : ""), user.id))
                }
                if (assigned && !options.some(option => option.value === assigned)) {
                  options.push(new Option(assigneeFallback(assigned, directory), assigned))
                }
                assignSelect.replaceChildren(...options)
                assignSelect.value = assigned
                assigneeReady = directory !== null
                assignSelect.disabled = _isPopulating || !assigneeReady
              }
              void taskApi.listUserDirectory(modalSignal).then(renderAssignees).catch(() => renderAssignees(null))
            }
            const settings = fetch("/api/settings", requestOptions)
            // Observe rejections immediately. Field handlers consume the original promises in order.
            void Promise.allSettled([lanes, backlogModeSetting, areas, projectRead, pillars, settings])

            // Populate status dropdown from lanes API
            try {
              const [lanesRes, modeRes] = await Promise.all([lanes, backlogModeSetting])
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
                const lanesData = await lanesRes.json()
                if (modalSignal.aborted) return
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
                  if (Array.isArray(lane.includes) && lane.includes.some((status: unknown) => typeof status === "string" && isDoneStatus(status))) {
                    opt.dataset.statusMeaning = "complete"
                  }
                  opt.textContent = lane.label;
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
              parentEl.href = buildTaskPermalink({ id: String(t.parent_id), ticket_key: t.parent_ticket_key })
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
            let unlinkParentButton: HTMLButtonElement | undefined
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
                unlinkParentButton = unlinkBtn
                unlinkBtn.disabled = true
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
                const none = document.createElement("span")
                none.className = "text-xs text-text-muted italic"
                none.textContent = "None"
                linkParentDisplay.replaceChildren(none)
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
                const childRes = await fetch( // nosemgrep
                  `${window.__ingress_path || ""}/api/tasks?parent_id=${taskId}`, // nosemgrep
                  requestOptions,
                );
                if (modalSignal.aborted) return
                if (childRes.ok) {
                  const childData = await childRes.json()
                  if (modalSignal.aborted) return
                  const children = childData.tasks ?? [];
                  if (children.length === 0) {
                    const empty = document.createElement("span")
                    empty.className = "text-xs text-text-muted italic"
                    empty.textContent = "No children"
                    childrenDiv.replaceChildren(empty)
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
                if (modalSignal.aborted) return
                const dash = document.createElement("span")
                dash.className = "text-xs text-text-muted italic"
                dash.textContent = "—"
                childrenDiv.replaceChildren(dash)
                if (progressWrap) progressWrap.classList.add("hidden");
              }
            }

            // Activity remains lazy and belongs to this open ticket's lifetime.
            const activityDiv = document.getElementById("td-activity")
            const activityStatus = document.getElementById("td-activity-status")
            const activityRetry = document.getElementById("td-activity-retry")
            const activityDetails = activityDiv?.closest("details")
            if (activityDetails && activityDiv && activityStatus && activityRetry) {
              activityDiv.replaceChildren()
              activityStatus.textContent = ""
              activityRetry.hidden = true
              let activityState: "idle" | "loading" | "loaded" | "failed" = "idle"
              const loadActivity = async () => {
                if (modalSignal.aborted || activityState === "loading" || activityState === "loaded") return
                activityState = "loading"
                activityStatus.textContent = activityStatus.dataset.loading ?? ""
                activityRetry.hidden = true
                try {
                  const response = await fetch( // nosemgrep
                    `/api/tasks/${encodeURIComponent(taskId)}/activity`, // nosemgrep
                    { signal: modalSignal, cache: "no-store" },
                  )
                  const directives = response.headers.get("cache-control")?.toLowerCase().split(",")
                  if (!response.ok || !directives?.some(value => value.trim() === "no-store")) {
                    throw new Error("Invalid activity response")
                  }
                  const data = await response.json()
                  if (modalSignal.aborted) return
                  const entries = Array.isArray(data) ? data : data?.activity
                  if (!Array.isArray(entries)) throw new Error("Invalid activity data")
                  activityState = "loaded"
                  activityStatus.textContent = entries.length ? "" : (activityStatus.dataset.empty ?? "")
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
                  if (modalSignal.aborted) return
                  activityState = "failed"
                  activityStatus.textContent = activityStatus.dataset.failed ?? ""
                  activityRetry.hidden = false
                }
              }
              activityDetails.addEventListener("toggle", () => {
                if (activityDetails.open) void loadActivity()
              }, { signal: modalSignal })
              activityRetry.addEventListener("click", () => void loadActivity(), { signal: modalSignal })
              if (activityDetails.open) void loadActivity()
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

            if (tdTitleInput) tdTitleInput.value = String(t.title ?? "")
            // Update aria-label with actual task title for screen readers
            setInspectorAriaLabel(`Task detail: ${String(t.title ?? "Untitled")}`);

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
            const taskStatus = statusSelect?.dataset.savedStatus ?? String(t.status ?? "pending");
            if (
              statusSelect &&
              !statusSelect.querySelector(`option[value="${taskStatus}"]`)
            ) {
              const opt = document.createElement("option");
              opt.value = taskStatus;
              opt.textContent = taskStatus;
              statusSelect.appendChild(opt);
            }
            renderSavedStatus(taskStatus)
            const description = String(t.description ?? "")
            const keepDescriptionDraft = sameTicket && !descEditContainer?.classList.contains("hidden") &&
              tdDescription.value !== _descOriginalValue
            setDescriptionSaving(false)
            if (descSaveBtn) descSaveBtn.disabled = true
            if (descSavedIndicator) descSavedIndicator.style.display = "none"
            _descOriginalValue = description
            if (!keepDescriptionDraft) {
              tdDescription.value = description
              descEditContainer?.classList.add("hidden")
              descView?.classList.remove("hidden")
              if (!description) enterDescEdit()
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

            const fallbackAccentHex = (() => {
              const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()
              return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#69e3b2"
            })()
            ;(document.getElementById("td-color") as HTMLInputElement).value =
              String(t.color ?? fallbackAccentHex);
            const dueInput = document.getElementById("td-due-date") as HTMLInputElement
            dueInput.value = String(t.due_date ?? "")
            dueInput.disabled = Number(t.routine_occurrence) === 1
            document.getElementById("td-routine-date-hint")?.toggleAttribute("hidden", !dueInput.disabled)
            const startInput = document.getElementById("td-start-date") as HTMLInputElement
            startInput.value = String(t.start_date ?? "")
            const endInput = document.getElementById("td-end-date") as HTMLInputElement
            endInput.value = String(t.end_date ?? "")
            const trackedInput = document.getElementById("td-time-tracked") as HTMLInputElement
            trackedInput.value = String(t.time_tracked ?? 0)
            if (areaField && areas) {
              const savedArea = String(t.area_id ?? "")
              try {
                const response = await areas
                if (!response.ok) throw new Error("Groups unavailable")
                const { areas: choices } = await response.json() as { areas: { id: string; name: string }[] }
                if (modalSignal.aborted) return
                if (!Array.isArray(choices) || choices.some(area => typeof area?.id !== "string" || !area.id || typeof area.name !== "string")) {
                  throw new Error("Invalid Groups")
                }
                areaField.replaceChildren(new Option("Without an Area", ""), ...choices.map(({ id, name }) => new Option(name, id)))
                if (savedArea && !choices.some(area => area.id === savedArea)) {
                  const label = window.mI18n?.get("task_detail.unavailable_group_selection") ?? "Saved selection unavailable"
                  const unavailable = new Option(label, savedArea)
                  unavailable.disabled = true
                  areaField.add(unavailable)
                }
                areaFieldReady = true
              } catch {
                if (modalSignal.aborted) return
                areaField.replaceChildren(new Option(window.mI18n?.get("task_detail.group_options_load_failed") ?? "Options could not load", savedArea))
              }
              areaField.value = savedArea
              areaField.dataset.savedArea = savedArea
            }
            if (projectField && projectRead) {
              const savedProject = String(t.project_id ?? "")
              try {
                const response = await projectRead
                if (!response.ok) throw new Error("Projects unavailable")
                const data = await response.json()
                if (modalSignal.aborted) return
                const projects = (data.projects ?? data) as Array<{ id: string, title: string, icon?: string }>
                projectField.replaceChildren(new Option("No project", ""))
                for (const project of projects) {
                  projectField.add(new Option(project.title, project.id))
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
              const pilRes = await pillars
              if (modalSignal.aborted) return
              if (pilRes.ok && pillarSelect) {
                const pilData = await pilRes.json()
                if (modalSignal.aborted) return
                const pillars = pilData.pillars ?? pilData ?? [];
                pillarSelect.replaceChildren(new Option("No pillar", ""));
                (pillars as Array<{ id: string; name: string; icon?: string }>).forEach((p) => {
                  const opt = document.createElement("option");
                  opt.value = p.id;
                  opt.textContent = p.name;
                  pillarSelect.appendChild(opt);
                });
                pillarSelect.value = currentPillarId;
              }
            } catch {
              if (modalSignal.aborted) return
              pillarSelect?.replaceChildren(new Option(currentPillarId, currentPillarId));
            }

            // Populate principle dropdown
            const principleSelect = document.getElementById(
              "td-principle",
            ) as HTMLSelectElement;
            const currentPrincipleId = String(t.principle_id ?? "");
            if (principleSelect) try {
              if (currentPillarId && currentPillarId !== "null" && currentPillarId !== "undefined") {
                const prinRes = await fetch( // nosemgrep
                  (window.__ingress_path || "") + `/api/pillars/${currentPillarId}/principles`, // nosemgrep
                  requestOptions,
                );
                if (modalSignal.aborted) return
                if (prinRes.ok) {
                  const prinData = await prinRes.json()
                  if (modalSignal.aborted) return
                  const principles = prinData.principles ?? prinData ?? [];
                  principleSelect.replaceChildren(new Option("No principle", ""));
                  (principles as Array<{ id: string; description: string }>).forEach((p) => {
                    const opt = document.createElement("option");
                    opt.value = p.id;
                    opt.textContent = `${p.description.substring(0, 30)}${p.description.length > 30 ? '...' : ''}`;
                    principleSelect.appendChild(opt);
                  });
                  principleSelect.value = currentPrincipleId;
                }
              } else {
                 principleSelect.replaceChildren(new Option("No principle", ""));
              }
            } catch {
              if (modalSignal.aborted) return
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
                  ? (recurrenceSelect.selectedOptions[0]?.textContent ?? "")
                  : "";
              }
            }

            const isFav = Number(t.is_favorite ?? 0) === 1;
            const favBtn = document.getElementById("td-toggle-favorite") as HTMLButtonElement | null;
            if (favBtn) {
              favBtn.setAttribute("aria-pressed", String(isFav));
              const favLabel = isFav ? "Remove from favorites" : "Add to favorites";
              favBtn.title = favLabel;
              favBtn.setAttribute("aria-label", favLabel);
            }
            const isPromoted = Boolean(t.is_promoted);
            const promoteBtn = document.getElementById("td-toggle-promote") as HTMLButtonElement | null;
            if (promoteBtn) {
              promoteBtn.setAttribute("aria-pressed", String(isPromoted));
              const promoteLabel = isPromoted
                ? (window.mI18n?.get("kanban.demote_card") ?? "Remove promotion")
                : (window.mI18n?.get("kanban.promote_card") ?? "Promote to top");
              promoteBtn.title = promoteLabel;
              promoteBtn.setAttribute("aria-label", promoteLabel);
            }

            // Load settings-defined custom fields
            _settingsFields = [];
            let allSettings: Record<string, unknown> = {};
            try {
              const settingsRes = await settings
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
            hasChecklistTextDraft = showTaskChecklist(taskId, t.checklists, modalSignal, send => saveTaskChecklist(taskId, send),
              typeof t.ticket_key === "string" ? t.ticket_key : undefined)
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
            commentsReady = loadComments({ id: taskId, ticket_key: currentTicketKey }, modalSignal, commentTarget)

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
            taskLoaded = true
            syncInspectorDockMode()
            tdLoaded?.classList.remove("hidden")
            void renderTaskDescription(description)
            resizeTitle()
            const finishLoadedTask = () => {
              const liveSignal = _modalAbortController?.signal
              if (!liveSignal || liveSignal.aborted || currentTaskId !== taskId || detailGeneration !== loadedGeneration) return
              _isPopulating = false
              if (descSaveBtn && !pendingDescriptionSave) descSaveBtn.disabled = false
              syncTaskActionControls()
              if (areaField) areaField.disabled = !areaFieldReady
              if (unlinkParentButton) unlinkParentButton.disabled = false
              if (projectField) projectField.disabled = !projectFieldReady
              if (assignSelect) assignSelect.disabled = !assigneeReady
              deferral.loaded(taskId, typeof t.project_id === "string" ? t.project_id : null, t.deferred_at != null, liveSignal, Boolean(searchSession))
              pins.loaded(taskId, liveSignal)
              const transition = queuedDescriptionTransition
              queuedDescriptionTransition = undefined
              transition?.()
            }
            resumeLoadedTask = finishLoadedTask
            setTimeout(finishLoadedTask, 100)
          } catch (e) {
            if (modalSignal.aborted) return
            log.error("Failed to load task detail", e);
            showTaskError(false)
          }
        }



        function showTaskWriteConflict() {
          if (document.getElementById("td-write-conflict")) return
          const notice = document.createElement("div")
          notice.id = "td-write-conflict"
          notice.className = "alert alert-warning"
          notice.setAttribute("role", "alert")
          notice.append("This task changed or its save could not be confirmed. Your input is kept here. Reload the saved task before making further changes. ")
          const refresh = document.createElement("button")
          refresh.type = "button"
          refresh.className = "btn btn-ghost"
          refresh.textContent = "Reload saved task"
          refresh.addEventListener("click", () => { if (currentTaskId) void openTaskDetail(currentTaskId) }, { signal: __signal })
          notice.append(refresh)
          document.getElementById("td-loaded-content")?.prepend(notice)
        }

        function queueTaskWrite<T>(taskId: string, write: () => T | Promise<T>): Promise<T> {
          const queued = (taskSaveQueues.get(taskId) ?? Promise.resolve()).then(write)
          const release = () => {
            if (taskSaveQueues.get(taskId) === drained) taskSaveQueues.delete(taskId)
          }
          const drained = queued.then(release, release)
          taskSaveQueues.set(taskId, drained)
          return queued
        }

        function saveTaskChecklist(taskId: string, send: (version: number | null) => Promise<Response>) {
          const generation = detailGeneration
          const context = currentTaskApiContext()
          const stillCurrent = () => generation === detailGeneration && currentTaskId === taskId &&
            !boardWithheld && currentTaskActions.has("edit") && sameTaskApiContext(context, currentTaskApiContext())
          return queueTaskWrite(taskId, async () => {
            if (!stillCurrent()) throw new Error("Task access changed")
            const version = currentTaskVersion
            const response = await send(version)
            if (version === null || !stillCurrent() || (!response.ok && response.status !== 409)) return response
            const saved = await response.clone().json().catch(() => null)
            if (!stillCurrent()) return response
            // Preserve independent checklist edits without silently adopting an external change to other fields.
            if (response.status === 409 && saved?.errorCode === "TASK_VERSION_CONFLICT") return send(null)
            if (response.ok && saved?.id === taskId) currentTaskVersion = taskRecordVersion(saved) ?? version
            return response
          })
        }

        function saveTaskField(field: string, value: unknown, updatedAt?: number): Promise<boolean> {
          if (!currentTaskId || _isPopulating || boardWithheld || !currentTaskActions.has("edit")) return Promise.resolve(false)
          const generation = detailGeneration
          return queueTaskWrite(currentTaskId, () => generation === detailGeneration ? saveTaskFieldNow(field, value, updatedAt) : false)
        }

        async function saveTaskFieldNow(field: string, value: unknown, updatedAt?: number): Promise<boolean> {
          if (!currentTaskId || _isPopulating || boardWithheld || !currentTaskActions.has("edit") || (field === "status" && !statusAllowed(String(value)))) return false
          if (taskSaveConflict) { showTaskWriteConflict(); return false }
          const generation = detailGeneration
          const taskId = currentTaskId
          const search = searchSession
          const completeDeferralWrite = deferral.nativeWrite(field, value)
          const scopedWrite = search || ["title", "status", "area_id", "project_id", "framework_payload"].includes(field) ? beginScopedWrite() : undefined
          let saved = false
          try {
            const result = await saveVersionedTask(taskId, { [field]: value }, updatedAt ?? currentTaskVersion, undefined,
              scopedWrite?.signal ?? AbortSignal.timeout(7_000))
            saved = result.ok
            if (result.ok && generation === detailGeneration) currentTaskVersion = result.version
            if (!result.ok && generation === detailGeneration && (result.errorCode === "conflict" || result.errorCode === "unconfirmed")) {
              taskSaveConflict = true
              showTaskWriteConflict()
            }
            if (saved) {
              if (field === "area_id") {
                changedAreaTask = taskId
                if (!tdOverlay.classList.contains("active") ||
                    (tdOverlay.dataset.openTaskId && generation !== detailGeneration)) {
                  reconcileAreaGrouping()
                }
              } else if (field === "parent_id" || field === "task_type" || field === "title") {
                epicGroupingDirty = true
                if (!tdOverlay.classList.contains("active")) reconcileEpicGrouping()
              }
              notifyInactivityTaskChanged(field === "status" ? undefined : taskId)
              if (field === "status") {
                const task = result.ok ? result.task : {}
                document.dispatchEvent(new CustomEvent("meitheal:task-status-saved", { detail: { id: taskId, status: task.status, deferred: task.deferred_at != null } }))
                if (value === "complete" && (!search || generation === detailGeneration)) onTaskCompleted(task)
              }
              return field === "area_id" || !search || generation === detailGeneration
            }
            if (!result.ok) log.warn(`Failed to save ${field}:`, result.status)
          } catch (err) {
            log.warn(`Network error saving ${field}:`, err)
          } finally {
            completeDeferralWrite(saved)
            scopedWrite?.finish()
          }
          const sessionBound = search || field === "description"
          if (sessionBound && generation !== detailGeneration) return false
          if (!sessionBound || generation === detailGeneration) showToast("common.failed_update", "error")
          return false
        }

        async function saveTD(field: string, value: unknown): Promise<void> {
          await saveTaskField(field, value)
        }

        // F11: Description Edit/Preview UX (simplified)
        const descEditContainer = document.getElementById("td-desc-edit-container");
        const descPreviewContainer = document.getElementById("td-desc-preview-container");
        const descView = descPreviewContainer?.closest(".td-description-view")
        const descPreview = document.getElementById("td-desc-preview");
        const tdDescription = document.getElementById("td-description") as HTMLTextAreaElement;
        const descEditBtnHover = document.getElementById("td-desc-edit-btn-hover");
        const descSaveBtn = document.querySelector<HTMLButtonElement>("#td-desc-save-btn")
        const descCancelBtn = document.querySelector<HTMLButtonElement>("#td-desc-cancel-btn")
        const descSavedIndicator = document.getElementById("td-desc-saved");

        let _descOriginalValue = "";
        let _descSavedTimer: number | null = null;
        let descriptionRenderSequence = 0

        async function renderTaskDescription(markdown: string): Promise<void> {
          if (!descPreview || __signal.aborted) return
          const generation = detailGeneration
          const sequence = ++descriptionRenderSequence
          const fallback = document.createElement("p")

          if (!markdown) {
            const placeholder = document.createElement("em")
            placeholder.textContent = "No description provided."
            fallback.append(placeholder)
            descPreview.replaceChildren(fallback)
            return
          }

          fallback.className = "whitespace-pre-wrap"
          fallback.textContent = markdown
          descPreview.replaceChildren(fallback)

          try {
            const [{ renderMarkdownToHtml }, { sanitizeClient }] = await Promise.all([
              import("@lib/markdown-client"),
              import("@lib/sanitize-client"),
            ])
            if (__signal.aborted || generation !== detailGeneration ||
                sequence !== descriptionRenderSequence || !descPreview.isConnected) return

            const sanitized = sanitizeClient(renderMarkdownToHtml(markdown))
            const parsedDoc = new DOMParser().parseFromString(sanitized, "text/html")
            resolveDescriptionTaskReferences(parsedDoc.body)
            descPreview.replaceChildren(...Array.from(parsedDoc.body.childNodes))
          } catch (error) {
            log.warn("Could not render task description Markdown", error)
          }
        }

        function enterDescEdit() {
          _descOriginalValue = tdDescription?.value ?? "";
          descEditContainer?.classList.remove("hidden");
          descView?.classList.add("hidden");
          tdDescription?.focus();
        }

        function setDescriptionSaving(saving: boolean): void {
          tdDescription.readOnly = saving
          descEditContainer?.setAttribute("aria-busy", String(saving))
          if (descCancelBtn) descCancelBtn.disabled = saving
          if (descSaveBtn) {
            descSaveBtn.disabled = saving
            descSaveBtn.textContent = (saving ? descSaveBtn.dataset.saving : descSaveBtn.dataset.save) ?? ""
          }
        }

        async function exitDescEdit(save: boolean): Promise<boolean> {
          if (!tdDescription || descSaveBtn?.disabled) return false
          closeTaskReferences()
          if (save) {
            const generation = detailGeneration
            const raw = tdDescription.value
            setDescriptionSaving(true)
            const write = saveTaskField("description", raw)
            pendingDescriptionSave = write
            const saved = await write
            if (pendingDescriptionSave === write) pendingDescriptionSave = undefined
            if (__signal.aborted || generation !== detailGeneration) return false
            setDescriptionSaving(false)
            if (!saved) {
              tdDescription.focus()
              return false
            }
            _descOriginalValue = raw
            void renderTaskDescription(raw)
            if (descSavedIndicator) {
              descSavedIndicator.style.display = ""
              if (_descSavedTimer) clearTimeout(_descSavedTimer)
              _descSavedTimer = window.setTimeout(() => { descSavedIndicator.style.display = "none"; _descSavedTimer = null }, 1500)
            }
          } else {
            tdDescription.value = _descOriginalValue
          }
          descEditContainer?.classList.add("hidden")
          descView?.classList.remove("hidden")
          descEditBtnHover?.focus({ preventScroll: true })
          return true
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
        if (tdTitleInput) {
          tdTitleInput.addEventListener("blur", (e) =>
            saveTD("title", (e.target as HTMLTextAreaElement).value),
          { signal: __signal });
          tdTitleInput.addEventListener("input", resizeTitle, { signal: __signal })
        }


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

        async function saveDetailStatus(next: string) {
          const id = currentTaskId
          if (!id || !statusSelect || statusSelect.disabled) return
          const previous = statusSelect.dataset.savedStatus ?? statusSelect.value
          if (!statusAllowed(next)) {
            statusSelect.value = previous
            return
          }
          const unlock = lockTaskStatusWrite(id)
          if (!unlock) {
            statusSelect.value = previous
            showToast("A status change is still saving.")
            return
          }
          const generation = detailGeneration
          setStatusBusy(true)
          try {
            const saved = await saveTaskField("status", next)
            if (generation === detailGeneration && (saved || !taskSaveConflict)) renderSavedStatus(saved ? next : previous)
          } finally {
            unlock()
            if (generation === detailGeneration) setStatusBusy(false)
          }
        }

        statusSelect?.addEventListener("change", () => void saveDetailStatus(statusSelect.value), { signal: __signal })
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
        document.getElementById("td-area")?.addEventListener("change", async event => {
          const select = event.currentTarget as HTMLSelectElement
          const modalSignal = _modalAbortController?.signal
          const taskId = currentTaskId
          const areaId = select.value
          const previous = select.dataset.savedArea
          if (!taskId || !modalSignal || select.disabled || areaId === previous) return
          const ticketKey = currentTicketKey
          const hadFocus = document.activeElement === select
          select.disabled = true
          const write = saveTaskField("area_id", areaId || null).then(saved => saved ? areaId : null).finally(() => {
            if (pendingAreaWrites.get(taskId) === write) pendingAreaWrites.delete(taskId)
            if (ticketKey && pendingAreaWrites.get(ticketKey) === write) pendingAreaWrites.delete(ticketKey)
          })
          pendingAreaWrites.set(taskId, write)
          if (ticketKey) pendingAreaWrites.set(ticketKey, write)
          const savedArea = await write
          if (modalSignal.aborted) return
          if (savedArea !== null) select.dataset.savedArea = savedArea
          else if (!taskSaveConflict) select.value = previous ?? ""
          select.disabled = false
          if (hadFocus && document.activeElement === document.body) select.focus({ preventScroll: true })
        }, { signal: __signal })
        // Project change auto-save
        document.getElementById("td-project")?.addEventListener("change", async (event) => {
          const select = event.currentTarget as HTMLSelectElement
          const modalSignal = _modalAbortController?.signal
          const projectId = select.value
          select.disabled = true
          const saved = await saveTaskField("project_id", projectId || null)
          if (modalSignal?.aborted) return
          if (saved) select.dataset.savedProject = projectId
          else if (!taskSaveConflict) select.value = select.dataset.savedProject ?? ""
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
            principleSelect.replaceChildren(new Option("No principle", ""));
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
                    opt.textContent = `${p.description.substring(0, 30)}${p.description.length > 30 ? '...' : ''}`;
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
            const sel = e.target as HTMLSelectElement
            if (sel.disabled || _isPopulating || !currentTaskId) return
            const val = sel.value || null
            saveTD("assigned_to", val)
            const label = val
              ? (sel.options[sel.selectedIndex]?.textContent ?? val)
              : "Unassigned";
            showToast(val ? `Assigned to ${label}` : "Unassigned");
          }, { signal: __signal });
        // UX2: Keyboard shortcut 'A' to focus assignee dropdown in detail panel
        document.addEventListener("keydown", (e) => {
          const panel = document.getElementById("task-detail-panel");
          if (!panel || panel.style.display === "none") return;
          if (!tdOverlay.classList.contains("active") || hasPriorityOverlay() || !document.getElementById("shortcut-modal")?.classList.contains("hidden")) return;
          if (document.body.classList.contains("has-docked-inspector") && !panel.contains(document.activeElement)) return;
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
            const assignee = document.getElementById("td-assigned-to")
            const disclosure = assignee?.closest("details")
            if (disclosure) disclosure.open = true
            assignee?.focus()

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
              if (__signal.aborted || parentSearchInput.value.trim() !== q) return
              const tasks = (data.tasks ?? []).filter(
                (t: Record<string, unknown>) => t.id !== currentTaskId,
              );
              if (tasks.length === 0) {
                const empty = document.createElement("div")
                empty.className = "px-3 py-2 text-xs text-text-muted italic"
                empty.textContent = "No matches"
                parentResultsDiv.replaceChildren(empty)
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
          if (e.key === "Escape" && parentResultsDiv?.style.display === "block") {
            e.preventDefault()
            clearTimeout(parentSearchTimer)
            parentResultsDiv.style.display = "none"
            parentSearchInput.value = ""
          }
        }, { signal: __signal });

        // ───── Related Links (extracted) ─────
        const relatedLinksApi = initRelatedLinks({
          getCurrentTaskId: () => currentTaskId,
          openTaskDetail,
          saveTD,
        })
        const loadRelatedLinks = relatedLinksApi.loadRelatedLinks


        doneButton?.addEventListener("click", () => {
          if (statusSelect) void saveDetailStatus(isDoneStatus(statusSelect.value) ? "pending" : "complete")
        }, { signal: __signal })

        // Toggle promoted (sash highlight & top of lane)
        document
          .getElementById("td-toggle-promote")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const search = searchSession
            const generation = detailGeneration
            const btn = document.getElementById("td-toggle-promote") as HTMLButtonElement | null;
            if (!btn || btn.disabled) return;
            const wasPromoted = btn.getAttribute("aria-pressed") === "true";
            const nextPromoted = !wasPromoted;
            btn.disabled = true;
            btn.setAttribute("aria-busy", "true");
            btn.setAttribute("aria-pressed", String(nextPromoted));
            try {
              const saved = await saveTaskField("is_promoted", nextPromoted);
              if (search && generation !== detailGeneration) return;
              if (saved === false) {
                btn.setAttribute("aria-pressed", String(wasPromoted));
                return;
              }
              const promoteLabel = nextPromoted
                ? (window.mI18n?.get("kanban.demote_card") ?? "Remove promotion")
                : (window.mI18n?.get("kanban.promote_card") ?? "Promote to top");
              btn.title = promoteLabel;
              btn.setAttribute("aria-label", promoteLabel);
              showToast(nextPromoted
                ? (window.mI18n?.get("kanban.card_promoted") ?? "Promoted to the top of the lane")
                : (window.mI18n?.get("kanban.card_demoted") ?? "Promotion removed"));
              document.dispatchEvent(new CustomEvent("kanban:detail-changed", { detail: { id: currentTaskId } }));
            } finally {
              btn.removeAttribute("aria-busy");
              // A save that outlives its page must not change the next page's controls.
              if (!__signal.aborted) syncTaskActionControls();
            }
          }, { signal: __signal });

        // Toggle favorite (keeps Tabler icon intact)
        document
          .getElementById("td-toggle-favorite")
          ?.addEventListener("click", async () => {
            if (!currentTaskId) return;
            const search = searchSession
            const generation = detailGeneration
            const btn = document.getElementById(
              "td-toggle-favorite",
            ) as HTMLButtonElement | null;
            if (!btn) return;
            const isFav = btn.getAttribute("aria-pressed") === "true";
            const nextFav = !isFav;
            btn.setAttribute("aria-pressed", String(nextFav));
            await saveTD("is_favorite", nextFav ? 1 : 0);
            if (search && generation !== detailGeneration) return;
            const favLabel = nextFav ? "Remove from favorites" : "Add to favorites";
            btn.title = favLabel;
            btn.setAttribute("aria-label", favLabel);
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
                showToast("Failed to duplicate", "error")
                return;
              }
              const data = await res.json();
              if (stale()) return
              showToast(`Duplicated → ${data.title}`, "success")
              if (!search?.queued) void openTaskDetail(data.id)
            } catch {
              if (stale()) return
              showToast("common.network_error", "error")
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
                showToast("Failed to save attachment.", "error")
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
            if (!taskId || !currentTaskActions.has("delete") || boardWithheld || !_modalAbortController || _modalAbortController.signal.aborted) return
            if (taskSaveConflict) { showTaskWriteConflict(); return }
            const version = currentTaskVersion
            const context = currentTaskApiContext()
            const search = searchSession
            const generation = detailGeneration
            const lifetime = _modalAbortController.signal
            const confirmationSignal = AbortSignal.any([__signal, lifetime, ...(search ? [search.lifetime.signal] : [])])
            const stale = () => generation !== detailGeneration || boardWithheld || confirmationSignal.aborted || !sameTaskApiContext(context, currentTaskApiContext())
            const ok = await confirmDialog({
              message: "This task will be permanently deleted.",
              variant: "danger",
              confirmText: "Delete Task",
              title: "Delete Task",
              signal: confirmationSignal,
            });
            if (!ok || stale() || taskId !== currentTaskId) return
            const scopedWrite = beginScopedWrite()
            try {
              const result = await deleteVersionedTask(taskId, version, context,
                AbortSignal.any([confirmationSignal, ...(scopedWrite ? [scopedWrite.signal] : []), AbortSignal.timeout(7_000)]))
              if (stale()) return
              if (result.ok) {
                const deferred = deferral.removing(taskId)
                hasChecklistTextDraft = undefined
                closeTD("discard")
                if (!deferred && !scopedWrite) document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "task-deleted" } }))
              } else {
                taskSaveConflict = true
                showTaskWriteConflict()
              }
            } catch {
              if (stale()) return
              taskSaveConflict = true
              showTaskWriteConflict()
            } finally {
              scopedWrite?.finish()
            }
          }, { signal: __signal });

        let commentAttempt: { taskId: string, draft: string, key: string } | undefined
        commentButton?.addEventListener("click", async () => {
          const taskId = currentTaskId
          const ticketKey = currentTicketKey
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
            if (!signal.aborted) await loadComments({ id: taskId, ticket_key: ticketKey }, signal, null, id)
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
          const link = buildTaskPermalink(currentTicketKey ?? taskId)
          const copied = await copyToClipboard(link)
          if (__signal.aborted || currentTaskId !== taskId) return
          if (copied) {
            copyFallback?.setAttribute("hidden", "")
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
          if (e.target === tdOverlay && !focusMode && !document.body.classList.contains("has-docked-inspector")) closeTD("discard")
        }, { signal: __signal });

        function checkTaskLocation(fromHistory = false) {
          if (waitForDetailWrites(() => checkTaskLocation(fromHistory))) return
          if (fromHistory) {
            restoreTaskBackgroundUrl()
            saveNavigationState()
          }
          const url = new URL(window.location.href)
          const taskId = ticketIdFromPath(url.pathname, window.__ingress_path) ?? getLegacyTaskId(url.hash) ?? url.searchParams.get("open") ?? url.searchParams.get("ticket")
          const commentTarget = url.searchParams.get("comment")
          if (taskId === null) closeTD("discard", false)
          else if (tdOverlay.dataset.suppressUrlOpen !== "true" &&
            (!sameTaskLocator(taskId, currentTaskId, currentTicketKey) || commentTarget !== currentCommentTarget || !tdOverlay.classList.contains("active"))) {
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

