
  import { DropdownController } from "./dropdown-controller"
  import { safeIngressHref } from "./ingress-navigation"
  import { sanitizeCssColor } from "./safe-html"
  import { createTablerSvgElement, renderIconOrCustomEmoji } from "./tabler-svg"
  import { showToast } from "./toast"
  import { TASK_COUNTS_CHANGED } from "./deferral-client"

import { currentTaskApiContext, taskApiHeaders, type TaskApiContext } from "./task-api"
import { sameTaskApiContext } from "./task-api-client"
import { boardWorkspaceHref } from "./board-workspace"

interface SidebarHierarchyActions {
  insertAreaNode(container: HTMLElement, id: string, name: string, icon: string, color: string): void
  insertProjectNode(container: HTMLElement, id: string, name: string, icon: string, color: string, areaId: string): void
  newArea(owner: HTMLElement, created: () => void): void
  refresh(): void
  dispose(): void
}

export function bindSidebarHierarchyActions(nav: HTMLElement, pageSignal: AbortSignal): SidebarHierarchyActions | undefined {
  const host = window as typeof window & { __meithealHierarchyActions?: { nav: HTMLElement; signal: AbortSignal; controller: AbortController; api: SidebarHierarchyActions } }
  const previous = host.__meithealHierarchyActions
  if (previous?.nav === nav && previous.signal === pageSignal && !previous.controller.signal.aborted) return previous.api
  previous?.controller.abort()
  const documentContext = currentTaskApiContext()
  if (pageSignal.aborted || !documentContext?.actorKey) return
    const ctrl = new DropdownController()
    const areaActions = new AbortController()
    const ownedPortals: HTMLElement[] = []
    const countTimers = new Set<ReturnType<typeof setTimeout>>()
    pageSignal.addEventListener("abort", () => areaActions.abort(), { once: true, signal: areaActions.signal })
    areaActions.signal.addEventListener("abort", () => {
      ctrl.hide()
      for (const popup of ownedPortals) popup.remove()
      for (const timer of countTimers) clearTimeout(timer)
      nav.querySelectorAll(".stree__inline-input, .stree__confirm-delete").forEach(element => element.remove())
    }, { once: true })


    const pending = new Map<AbortController, HTMLElement>()
    const ownerFor = (kind: "area" | "project", id: string) => nav.querySelector<HTMLElement>(kind === "area"
      ? `[data-area-group="${CSS.escape(id)}"]` : `.stree__project [data-project-id="${CSS.escape(id)}"]`)
    const entityBoard = (kind: "area" | "project", id: string) => ownerFor(kind, id)?.closest<HTMLElement>("[data-work-board]")?.dataset.workBoard ?? ""
    const allowed = (kind: "area" | "project", id: string, action: string) => {
      const value = ownerFor(kind, id)?.closest<HTMLElement>("[data-work-actions]")?.dataset.workActions ?? ""
      return value.split(" ").includes(`${kind}/${action}`)
    }
    const live = (owner: HTMLElement, context: TaskApiContext) => !areaActions.signal.aborted && owner.isConnected && sameTaskApiContext(documentContext, currentTaskApiContext()) && Boolean(context.boardId)
    async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
      const target = new URL(input, location.href)
      const match = /^\/api\/(areas|projects)\/([^/]+)$/.exec(target.pathname)
      let owner: HTMLElement | null = null
      if (match) owner = ownerFor(match[1] === "areas" ? "area" : "project", decodeURIComponent(match[2]!))
      else if (typeof init.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>
        if (typeof body.project_id === "string") owner = ownerFor("project", body.project_id)
        else if (typeof body.area_id === "string") owner = ownerFor("area", body.area_id)
      }
      if (!owner) throw new Error("Original work context is unavailable")
      return command(owner, input, init)
    }
    async function command(owner: HTMLElement, input: string, init: RequestInit): Promise<Response> {
      const boardId = owner.closest<HTMLElement>("[data-work-board]")?.dataset.workBoard
      if (!boardId || !documentContext) throw new Error("Original work context is unavailable")
      const context = { ...documentContext, boardId }
      if (!live(owner, context)) throw new Error("Original work context changed")
      const request = new AbortController()
      pending.set(request, owner)
      try {
        const response = await window.fetch(input, { ...init, headers: taskApiHeaders(context, init.headers),
          signal: AbortSignal.any([areaActions.signal, request.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(7_000)]) })
        if (!live(owner, context)) throw new Error("Original work context changed")
        return response
      } finally { pending.delete(request) }
    }
    const abortPending = () => {
      for (const request of pending.keys()) request.abort()
      ctrl.hideAll()
      activeEntityId = null; activeEntityName = null; activeProjectIdForTask = null; activeEntityOwner = null
      nav.querySelectorAll(".stree__inline-input, .stree__confirm-delete").forEach(node => node.remove())
    }
    const observer = new MutationObserver(() => {
      if (!sameTaskApiContext(documentContext, currentTaskApiContext())) { areaActions.abort(); return }
      if (activeEntityOwner && !activeEntityOwner.isConnected) abortPending()
      for (const [request, owner] of pending) if (!owner.isConnected || !sameTaskApiContext(documentContext, currentTaskApiContext())) request.abort()
    })
    observer.observe(nav, { childList: true, subtree: true })
    observer.observe(document.head, { attributes: true, subtree: true, attributeFilter: ["content"] })
    document.addEventListener("meitheal:board-hidden", abortPending, { signal: areaActions.signal })
    document.addEventListener("meitheal:board-revoked", abortPending, { signal: areaActions.signal })
    areaActions.signal.addEventListener("abort", () => { abortPending(); observer.disconnect() }, { once: true })

    // ── i18n helper: read from window.mI18n or fallback ──
    function i18n(key: string, fallback: string): string {
      if (typeof window !== "undefined" && window.mI18n) {
        const v = window.mI18n.get(key)
        if (v && v !== key) return v
      }
      return fallback
    }

    // ── Inline input helper (replaces prompt()) ──
    function showInlineInput(
      container: HTMLElement,
      placeholder: string,
      currentValue: string,
      onSubmit: (value: string) => void,
      returnTrigger?: HTMLElement | null,
    ): void {
      if (areaActions.signal.aborted) return
      // Remove any existing inline input in the same container
      container.querySelectorAll(".stree__inline-input").forEach((el) => el.remove())
      const input = document.createElement("input")
      input.type = "text"
      input.className = "stree__inline-input"
      input.placeholder = placeholder
      input.value = currentValue
      container.appendChild(input)
      input.focus()
      input.select()

      let submitted = false
      let blurTimer: ReturnType<typeof setTimeout> | undefined
      function submit() {
        clearTimeout(blurTimer)
        if (submitted || !input.isConnected || areaActions.signal.aborted) return
        submitted = true
        const val = input.value.trim()
        input.remove()
        if (val && val !== currentValue) onSubmit(val)
      }
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit() }
        if (e.key === "Escape") {
          e.preventDefault()
          clearTimeout(blurTimer)
          submitted = true
          input.remove()
          const trigger = returnTrigger ?? container.querySelector<HTMLElement>("button, a[href], summary")
            ?? container.closest("[data-area-group]")?.querySelector<HTMLElement>("[data-area-toggle]")
          if (trigger && trigger.offsetParent !== null && !trigger.closest("[hidden], [inert]")) trigger.focus()
        }
      }, { signal: areaActions.signal })
      input.addEventListener("focus", () => clearTimeout(blurTimer), { signal: areaActions.signal })
      input.addEventListener("blur", () => {
        clearTimeout(blurTimer)
        blurTimer = setTimeout(() => {
          if (input.isConnected && document.activeElement !== input) submit()
        }, 100)
      }, { signal: areaActions.signal })
    }

    // ── Inline confirm helper (replaces confirm()) ──
    function showInlineConfirm(
      container: HTMLElement,
      label: string,
      onConfirm: () => void,
    ): void {
      if (areaActions.signal.aborted) return
      container.querySelectorAll(".stree__confirm-delete").forEach((el) => el.remove())
      const trigger = container.querySelector<HTMLElement>("[data-area-menu], [data-project-menu]")
      const confirmation = new AbortController()
      const signal = AbortSignal.any([areaActions.signal, confirmation.signal])
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "stree__confirm-delete"
      btn.textContent = label
      container.appendChild(btn)
      btn.focus()
      let expiry: ReturnType<typeof setTimeout> | undefined
      function dismiss(restoreFocus: boolean) {
        clearTimeout(expiry)
        btn.remove()
        confirmation.abort()
        if (restoreFocus && trigger?.isConnected && trigger.offsetParent !== null
          && getComputedStyle(trigger).visibility === "visible" && !trigger.closest("[hidden], [inert], details:not([open])")) trigger.focus()
      }
      btn.addEventListener("click", (event) => { event.stopPropagation(); dismiss(false); onConfirm() }, { signal })
      btn.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        dismiss(true)
      }, { signal })
      signal.addEventListener("abort", () => { clearTimeout(expiry); btn.remove() }, { once: true })
      // Auto-dismiss after 3s
      expiry = setTimeout(() => dismiss(document.activeElement === btn), 3000)
    }

    // ── DOM insertion: add new project row without reload ──
    function insertProjectNode(
      container: HTMLElement,
      projectId: string,
      title: string,
      icon: string,
      color: string,
      areaId: string,
    ): void {
      const div = document.createElement("div")
      div.className = "stree__project"
      if (container.matches("[data-board-projects]")) div.dataset.groupChoice = projectId
      div.dataset.workBoard = container.closest<HTMLElement>("[data-work-board]")?.dataset.workBoard ?? ""
      div.dataset.workActions = container.closest<HTMLElement>("[data-work-actions]")?.dataset.workActions ?? ""
      const safeColor = sanitizeCssColor(color)

      const connector = document.createElement("div")
      connector.className = "stree__connector"
      const lineV = document.createElement("span")
      lineV.className = "stree__line-v"
      const lineH = document.createElement("span")
      lineH.className = "stree__line-h"
      connector.append(lineV, lineH)

      const link = document.createElement("a")
      link.href = safeIngressHref(boardWorkspaceHref(div.dataset.workBoard!, { project: projectId, fromArea: areaId || undefined }))
      link.className = "stree__project-link"
      link.dataset.projectId = projectId
      link.dataset.projectName = title
      link.title = title

      const iconSpan = document.createElement("span")
      iconSpan.className = "stree__project-icon inline-flex items-center justify-center"
      iconSpan.style.color = safeColor
      renderIconOrCustomEmoji(iconSpan, icon, "checklist", 14)

      const nameSpan = document.createElement("span")
      nameSpan.className = "stree__project-name"
      nameSpan.textContent = title
      link.append(iconSpan, nameSpan)

      const countSpan = document.createElement("span")
      countSpan.className = "stree__count"
      countSpan.dataset.projectTaskCount = projectId
      countSpan.textContent = "0"

      const actions = document.createElement("div")
      actions.className = "stree__actions"

      const menuBtn = document.createElement("button")
      menuBtn.type = "button"
      menuBtn.className = "stree__action-btn"
      menuBtn.dataset.projectMenu = projectId
      menuBtn.dataset.projectTitle = title
      menuBtn.dataset.projectColor = safeColor
      menuBtn.dataset.projectIconValue = icon
      menuBtn.title = "Project options"
      menuBtn.setAttribute("aria-label", `Project options - ${title}`)
      menuBtn.appendChild(createTablerSvgElement("dots", 13))

      const addBtn = document.createElement("button")
      addBtn.type = "button"
      addBtn.className = "stree__action-btn stree__action-btn--add"
      addBtn.dataset.taskAddProject = projectId
      addBtn.dataset.taskAddName = title
      addBtn.title = "Add task"
      addBtn.setAttribute("aria-label", `Add task to ${title}`)
      addBtn.appendChild(createTablerSvgElement("plus", 13))

      actions.append(menuBtn)
      if (div.dataset.workActions.split(" ").includes("task/create")) actions.append(addBtn)
      div.append(connector, link, countSpan, actions)
      // Mark previous last project as no longer last
      const existingLast = container.querySelector(".stree__project--last")
      if (existingLast) existingLast.classList.remove("stree__project--last")
      div.classList.add("stree__project--last")
      // Insert before inline inputs or at end
      const inlineInput = container.querySelector(".stree__inline-input")
      if (inlineInput) container.insertBefore(div, inlineInput)
      else container.appendChild(div)
      // Animate in
      div.style.opacity = "0"
      div.style.transition = "opacity 200ms ease"
      requestAnimationFrame(() => { div.style.opacity = "1" })
    }

    // ── DOM insertion: add new area block without reload ──
    function insertAreaNode(
      navEl: HTMLElement,
      areaId: string,
      name: string,
      icon: string,
      color: string,
    ): void {
      const list = navEl.querySelector("#project-nav-list") ?? navEl
      if (!list) return
      const div = document.createElement("div")
      div.className = "stree__area"
      div.dataset.areaGroup = areaId
      div.dataset.workBoard = navEl.closest<HTMLElement>("[data-work-board]")?.dataset.workBoard ?? ""
      div.dataset.workActions = navEl.closest<HTMLElement>("[data-work-actions]")?.dataset.workActions ?? ""
      const safeColor = sanitizeCssColor(color)

      const row = document.createElement("div")
      row.className = "stree__area-row"

      const toggleBtn = document.createElement("button")
      toggleBtn.type = "button"
      toggleBtn.className = "stree__area-toggle"
      toggleBtn.dataset.areaToggle = areaId
      toggleBtn.dataset.areaNameLabel = name
      toggleBtn.setAttribute("aria-expanded", "true")
      toggleBtn.setAttribute("aria-controls", `stree-area-projects-${areaId}`)
      toggleBtn.setAttribute("aria-label", name)
      toggleBtn.title = `Collapse ${name}`

      const chevronSpan = document.createElement("span")
      chevronSpan.className = "stree__toggle"
      chevronSpan.setAttribute("aria-hidden", "true")
      const chevronSvg = createTablerSvgElement("chevron-down", 11)
      chevronSvg.classList.add("-rotate-90")
      chevronSpan.appendChild(chevronSvg)

      const areaIcon = document.createElement("span")
      areaIcon.className = "stree__area-icon inline-flex items-center justify-center"
      areaIcon.style.color = safeColor
      areaIcon.setAttribute("aria-hidden", "true")
      renderIconOrCustomEmoji(areaIcon, icon, "folders", 15)

      const areaName = document.createElement("span")
      areaName.className = "stree__area-name"
      areaName.textContent = name
      toggleBtn.append(chevronSpan, areaIcon, areaName)

      const actions = document.createElement("div")
      actions.className = "stree__actions"

      const menuBtn = document.createElement("button")
      menuBtn.type = "button"
      menuBtn.className = "stree__action-btn"
      menuBtn.dataset.areaMenu = areaId
      menuBtn.dataset.areaName = name
      menuBtn.dataset.areaColor = safeColor
      menuBtn.dataset.areaIcon = icon
      menuBtn.title = "Area options"
      menuBtn.setAttribute("aria-label", `Area options - ${name}`)
      menuBtn.appendChild(createTablerSvgElement("dots", 13))

      const addBtn = document.createElement("button")
      addBtn.type = "button"
      addBtn.className = "stree__action-btn stree__action-btn--add"
      addBtn.dataset.areaAdd = areaId
      addBtn.title = `New project in ${name}`
      addBtn.setAttribute("aria-label", `New project in ${name}`)
      addBtn.appendChild(createTablerSvgElement("plus", 13))

      actions.append(menuBtn)
      if (div.dataset.workActions.split(" ").includes("project/create")) actions.append(addBtn)
      row.append(toggleBtn, actions)

      const children = document.createElement("div")
      children.className = "stree__children"
      children.id = `stree-area-projects-${areaId}`
      children.dataset.areaProjects = areaId
      const emptyHint = document.createElement("span")
      emptyHint.className = "stree__empty-hint"
      emptyHint.textContent = i18n("sidebar.no_projects", "No projects")
      if (navEl.dataset.projectsEnabled === "true") children.appendChild(emptyHint)

      div.append(row, children)
      // Insert before the "New Area" button
      const newAreaBtn = list.querySelector("#new-area-btn")
      if (newAreaBtn) list.insertBefore(div, newAreaBtn)
      else list.appendChild(div)
      // Animate in
      div.style.opacity = "0"
      div.style.transition = "opacity 200ms ease"
      requestAnimationFrame(() => { div.style.opacity = "1" })
    }

    // ── Materialize templates to body ──
    function materialize(tmplId: string): HTMLElement | null {
      const tmpl = document.getElementById(tmplId) as HTMLTemplateElement | null
      if (!tmpl) return null
      const clone = tmpl.content.firstElementChild?.cloneNode(true) as HTMLElement
      if (!clone) return null
      clone.hidden = true
      const owner = nav.closest<HTMLElement>("[data-sidebar-board-children]")
      if (owner?.id) clone.dataset.sidebarBoardOwner = owner.id
      document.body.appendChild(clone)
      ownedPortals.push(clone)
      return clone
    }

    const areaMenuDropdown = materialize("tmpl-area-menu")
    const projectMenuDropdown = materialize("tmpl-project-menu")
    const taskKindDropdown = materialize("tmpl-task-kind")
    const colorIconPopover = materialize("tmpl-color-icon")

    // ── State ──
    let activeEntityOwner: HTMLElement | null = null
    let activeEntityType: "area" | "project" = "area"
    let activeEntityId: string | null = null
    let activeEntityName: string | null = null
    let activeProjectIdForTask: string | null = null

    function closeTreePopup(): boolean {
      const popups = [areaMenuDropdown, projectMenuDropdown, taskKindDropdown, colorIconPopover]
      if (!popups.some(popup => popup && ctrl.isShowing(popup))) return false
      const taskKindOpen = taskKindDropdown && ctrl.isShowing(taskKindDropdown)
      const trigger = taskKindOpen
        ? nav.querySelector<HTMLElement>(`[data-task-add-project="${CSS.escape(activeProjectIdForTask ?? "")}"]`)
        : nav.querySelector<HTMLElement>(`[data-${activeEntityType === "area" ? "area" : "project"}-menu="${CSS.escape(activeEntityId ?? "")}"]`)
      ctrl.hideAll()
      const drawer = nav.closest<HTMLElement>("#sidebar")
      const mobileOpener = innerWidth <= 768 && drawer && !drawer.classList.contains("open")
        ? document.getElementById("menu-toggle") : null
      const focusTarget = mobileOpener ?? trigger
      focusTarget?.focus()
      return true
    }
    function dismissTreePopup(event: KeyboardEvent): boolean {
      if (event.defaultPrevented || event.key !== "Escape" || !closeTreePopup()) return false
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    // ── 1. Collapse/Expand ──
    const COLLAPSE_KEY = "meitheal_project_nav_collapsed"
    let collapsed: Set<string>
    try { const s = localStorage.getItem(COLLAPSE_KEY); collapsed = new Set(s ? JSON.parse(s) : []) } catch { collapsed = new Set() }
    function saveCollapsed() { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])) } catch { /* localStorage unavailable in private browsing */ } }

    function setAreaCollapsed(toggle: HTMLButtonElement, isCollapsed: boolean) {
      const areaId = toggle.dataset.areaToggle!
      const areaName = toggle.dataset.areaNameLabel || toggle.querySelector(".stree__area-name")?.textContent?.trim() || "area"
      const children = document.getElementById(toggle.getAttribute("aria-controls") ?? "")
      if (!children) return
      children.dataset.collapsed = String(isCollapsed)
      children.inert = isCollapsed
      toggle.setAttribute("aria-expanded", String(!isCollapsed))
      const label = isCollapsed ? `Expand ${areaName}` : `Collapse ${areaName}`
      toggle.title = label
      if (isCollapsed) collapsed.add(areaId)
      else collapsed.delete(areaId)
    }

    nav.querySelectorAll<HTMLButtonElement>("[data-area-toggle]").forEach((toggle) => {
      if (collapsed.has(toggle.dataset.areaToggle!)) setAreaCollapsed(toggle, true)
    })

    // ── 2. Pinned projects ──
    const PIN_KEY = `meitheal-pinned-projects:${documentContext.actorKey}`
    let pinnedIds: Set<string>
    try { const saved = localStorage.getItem(PIN_KEY); pinnedIds = new Set(saved ? JSON.parse(saved) : []) } catch { pinnedIds = new Set() }
    const pinKey = (id: string) => `${entityBoard("project", id)}:${id}`
    const isPinned = (id: string) => pinnedIds.has(pinKey(id))
    function savePinned() { try { localStorage.setItem(PIN_KEY, JSON.stringify([...pinnedIds])) } catch { /* Keep the original legacy key untouched; unattributed preferences do not become another actor's pins. */ } }

    function renderPinned() {
      if (areaActions.signal.aborted) return
      for (const container of nav.querySelectorAll<HTMLElement>("[data-board-pinned]")) {
      const list = container.querySelector<HTMLElement>("[data-board-pinned-list]")
      if (!list) continue
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const focusedRow = active?.closest<HTMLElement>("[data-pinned-project]")
      const focusedId = focusedRow && list.contains(focusedRow) ? focusedRow.dataset.pinnedProject : undefined
      const restoreFocus = focusedId !== undefined
      const oldIds = [...list.querySelectorAll<HTMLElement>("[data-pinned-project]")].map(row => row.dataset.pinnedProject!)
      const index = focusedId ? oldIds.indexOf(focusedId) : -1
      const preferredId = focusedId && isPinned(focusedId) ? focusedId
        : oldIds.slice(index + 1).find(id => isPinned(id))
          ?? oldIds.slice(0, index).reverse().find(id => isPinned(id))
      const unpinFocused = active?.matches(".stree__unpin-btn")
      const original = focusedId ? nav.querySelector<HTMLElement>(`.stree__project [data-project-id="${CSS.escape(focusedId)}"]`) : null
      container.hidden = true
      list.replaceChildren()
      pinnedIds.forEach((key) => {
        const boardId = container.closest<HTMLElement>("[data-work-board]")?.dataset.workBoard
        if (!boardId || !key.startsWith(boardId + ":")) return
        const id = key.slice(boardId.length + 1)
        const src = nav.querySelector<HTMLAnchorElement>(`.stree__project [data-project-id="${CSS.escape(id)}"]`)
        if (!src) return
        const row = document.createElement("div")
        row.className = "stree__pinned-row"
        row.dataset.pinnedProject = id
        const clone = src.cloneNode(true) as HTMLAnchorElement
        clone.classList.add("pinned-item")
        const unpinBtn = document.createElement("button")
        unpinBtn.type = "button"
        unpinBtn.className = "stree__action-btn stree__unpin-btn inline-flex items-center justify-center"
        unpinBtn.title = "Unpin"
        unpinBtn.setAttribute("aria-label", "Unpin project")
        unpinBtn.appendChild(createTablerSvgElement("pinned-off", 12))
        unpinBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); pinnedIds.delete(pinKey(id)); savePinned(); renderPinned() }, { signal: areaActions.signal })
        row.append(clone, unpinBtn)
        list.appendChild(row)
        container.hidden = false
      })
      if (!restoreFocus) continue
      const preferredRow = preferredId ? list.querySelector<HTMLElement>(`[data-pinned-project="${CSS.escape(preferredId)}"]`) : null
      const candidates = [
        preferredRow?.querySelector<HTMLElement>(unpinFocused ? ".stree__unpin-btn" : "a[href]"),
        original,
        original?.closest("[data-area-group]")?.querySelector<HTMLElement>("[data-area-toggle]"),
        nav.querySelector<HTMLElement>("#project-nav-group-toggle"),
        nav.closest("[data-sidebar-group]")?.querySelector<HTMLElement>("[data-sidebar-boards-toggle]"),
      ]
      candidates.find(element => {
        if (!element?.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility !== "visible"
          || element.closest("[hidden], [inert]")) return false
        const closed = element.closest("details:not([open])")
        if (closed && !(element.matches("summary") && element.parentElement === closed && !closed.parentElement?.closest("details:not([open])"))) return false
        const drawer = element.closest("#sidebar")
        return !(innerWidth <= 768 && drawer && !drawer.classList.contains("open"))
      })?.focus()
      }
    }
    renderPinned()

    // Right-click context menu — pin/unpin for projects, quick actions for areas
    nav.addEventListener("contextmenu", (e) => {
      const projectLink = (e.target as HTMLElement).closest<HTMLAnchorElement>("[data-project-id]")
      if (projectLink) {
        e.preventDefault()
        const id = projectLink.dataset.projectId!
        if (isPinned(id)) pinnedIds.delete(pinKey(id)); else pinnedIds.add(pinKey(id))
        savePinned()
        renderPinned()
        return
      }
      // Area right-click: open ⋯ menu
      const areaRow = (e.target as HTMLElement).closest<HTMLElement>(".stree__area-row")
      if (areaRow) {
        e.preventDefault()
        const menuBtn = areaRow.querySelector<HTMLButtonElement>("[data-area-menu]")
        if (menuBtn) menuBtn.click()
      }
    }, { signal: areaActions.signal })

    // Area buttons also work on rows inserted without a page reload.
    function onAreaClick(event: MouseEvent) {
      const button = (event.target as Element).closest<HTMLButtonElement>("button")
      if (!button) return
      if (button.hasAttribute("data-area-toggle") && !button.hasAttribute("data-peer-area-toggle")) {
        setAreaCollapsed(button, button.getAttribute("aria-expanded") === "true")
        saveCollapsed()
      }
      if (button.hasAttribute("data-area-add")) addProjectToArea(button)
      if (button.hasAttribute("data-area-menu")) showAreaMenu(button, event.detail === 0)
      if (button.hasAttribute("data-project-menu")) showProjectMenu(button, event.detail === 0)
      if (button.hasAttribute("data-task-add-project")) {
        event.preventDefault()
        event.stopPropagation()
        showTaskKind(button)
      }
    }

    // The sidebar element persists across Astro page swaps.
    nav.addEventListener("click", onAreaClick, { signal: areaActions.signal })
    window.addEventListener("resize", () => closeTreePopup(), { signal: areaActions.signal })
    for (const popup of [areaMenuDropdown, projectMenuDropdown, taskKindDropdown, colorIconPopover]) {
      popup?.addEventListener("keydown", dismissTreePopup, { signal: areaActions.signal })
    }

    function addProjectToArea(btn: HTMLButtonElement) {
      const areaId = btn.dataset.areaAdd
      if (!areaId) return
      const children = nav.querySelector(`[data-area-projects="${areaId}"]`) as HTMLElement | null
      if (!children) return
      // Ensure area is expanded
      if (children.dataset.collapsed === "true") {
        const toggle = nav.querySelector<HTMLButtonElement>(`[data-area-toggle="${areaId}"]`)
        if (toggle?.hasAttribute("data-peer-area-toggle")) toggle.click()
        else if (toggle) setAreaCollapsed(toggle, false)
        saveCollapsed()
      }
      showInlineInput(
        children,
        i18n("sidebar.new_project_placeholder", "Project name\u2026"),
        "",
        async (title) => {
          try {
            const res = await fetch("/api/projects", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ title, area_id: areaId, icon: "\ud83d\udccb", color: "#146C4E" }),
            })
            if (res.ok) {
              const data = await res.json()
              const projId = data.id || data.project?.id || ""
              insertProjectNode(children, projId, title, "\ud83d\udccb", "#146C4E", areaId)
              // Remove empty hint if present
              children.querySelector(".stree__empty-hint")?.remove()
              showToast(i18n("sidebar.project_created", "Project created"), "success")
            }
            else showToast(i18n("sidebar.error_create_failed", "Failed to create"), "error")
          } catch { showToast(i18n("sidebar.error_create_failed", "Failed to create"), "error") }
        },
        btn,
      )
    }

    async function showAreaMenu(btn: HTMLButtonElement, focusManage: boolean) {
      if (!areaMenuDropdown) return
      try {
        const response = await fetch(`/api/areas/${encodeURIComponent(btn.dataset.areaMenu ?? "")}`)
        if (!response.ok) throw new Error("Unavailable")
        const record = await response.json() as { icon?: string; color?: string }
        if (!btn.isConnected || areaActions.signal.aborted) return
        btn.dataset.areaIcon = record.icon ?? "📋"
        btn.dataset.areaColor = record.color ?? "#146C4E"
      } catch { showToast("This work is unavailable. Refresh the Board to try again.", "error"); return }

      const isVisible = ctrl.isShowing(areaMenuDropdown) && activeEntityId === btn.dataset.areaMenu && activeEntityType === "area"
      ctrl.hideAll()
      if (isVisible) return
      activeEntityType = "area"
      activeEntityOwner = ownerFor("area", btn.dataset.areaMenu ?? "")
      activeEntityId = btn.dataset.areaMenu!
      activeEntityName = btn.dataset.areaName || ""
      const manageLink = areaMenuDropdown.querySelector<HTMLAnchorElement>("[data-action='manage']")
      if (manageLink) manageLink.href = safeIngressHref(boardWorkspaceHref(entityBoard("area", activeEntityId), { area: activeEntityId, groups: true }, "group-settings"))
      const deletion = areaMenuDropdown.querySelector<HTMLButtonElement>("[data-action='delete']")
      if (deletion) deletion.style.display = ""
      for (const item of areaMenuDropdown.querySelectorAll<HTMLElement>("[data-action]")) {
        const action = item.dataset.action
        item.hidden = action !== "manage" && !allowed("area", activeEntityId, action === "delete" ? "delete" : "edit")
      }
      ctrl.show(areaMenuDropdown, btn)
      if (focusManage) manageLink?.focus()
    }

    areaMenuDropdown?.addEventListener("click", async (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
      if (!target || !activeEntityId || activeEntityType !== "area") return
      const action = target.dataset.action
      const entityId = activeEntityId
      const entityName = activeEntityName || ""

      if (action === "manage") return // navigates via <a> href
      if (action === "rename") {
        ctrl.hideAll()
        const toggle = nav.querySelector<HTMLButtonElement>(`[data-area-toggle="${entityId}"]`)
        const nameEl = toggle?.closest(".stree__area-row")?.querySelector<HTMLElement>(".stree__area-name")
        if (!toggle || !nameEl) return
        const container = nameEl.closest<HTMLElement>(".stree__area-row")!
        showInlineInput(
          container,
          i18n("sidebar.new_area_placeholder", "Area name\u2026"),
          entityName,
          async (newName) => {
            try {
              const res = await fetch(`/api/areas/${entityId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newName }) })
              if (res.ok) {
                nameEl.textContent = newName
                toggle.dataset.areaNameLabel = newName
                toggle.setAttribute("aria-label", newName)
                setAreaCollapsed(toggle, toggle.getAttribute("aria-expanded") === "false")
                const menu = container.querySelector<HTMLButtonElement>("[data-area-menu]")
                if (menu) {
                  menu.dataset.areaName = newName
                  menu.setAttribute("aria-label", `${menu.title} - ${newName}`)
                }
                const add = container.querySelector<HTMLButtonElement>("[data-area-add]")
                if (add) {
                  add.title = `New project in ${newName}`
                  add.setAttribute("aria-label", add.title)
                }
              } else showToast(i18n("sidebar.error_update_failed", "Failed to update"), "error")
            } catch { showToast(i18n("sidebar.error_update_failed", "Failed to update"), "error") }
          },
          container.querySelector<HTMLElement>("[data-area-menu]"),
        )
      }
      if (action === "color-icon") {
        ctrl.hide()
        if (!colorIconPopover) return
        const triggerBtn = nav.querySelector<HTMLButtonElement>(`[data-area-menu="${entityId}"]`)
        const currentIcon = triggerBtn?.dataset.areaIcon || "\ud83d\udccb"
        const currentColor = triggerBtn?.dataset.areaColor || "#146C4E"
        // Sync icon preview + hidden input
        const iconInput = colorIconPopover.querySelector<HTMLInputElement>("#entity-icon-input")
        const iconPreview = colorIconPopover.querySelector<HTMLSpanElement>("#entity-icon-preview")
        if (iconInput) iconInput.value = currentIcon
        if (iconPreview) renderIconOrCustomEmoji(iconPreview, currentIcon, "folders", 18)
        // Sync swatch selection
        colorIconPopover.querySelectorAll<HTMLButtonElement>("[data-swatch-color]").forEach((s) => s.classList.toggle("selected", s.dataset.swatchColor === currentColor))
        // Reset emoji tab to first
        colorIconPopover.querySelectorAll<HTMLButtonElement>("[data-emoji-tab]").forEach((t, i) => t.classList.toggle("active", i === 0))
        colorIconPopover.querySelectorAll<HTMLElement>("[data-emoji-panel]").forEach((p, i) => p.classList.toggle("hidden", i !== 0))
        if (triggerBtn) {
          ctrl.show(colorIconPopover, triggerBtn)
          colorIconPopover.querySelector<HTMLElement>(".stree__emoji-tab")?.focus()
        }
      }
      if (action === "delete") {
        ctrl.hideAll()
        const areaRow = nav.querySelector(`[data-area-toggle="${entityId}"]`)?.closest<HTMLElement>(".stree__area-row")
        if (!areaRow) return
        showInlineConfirm(
          areaRow,
          i18n("sidebar.delete_confirm_btn", "Confirm Delete"),
          async () => {
            try {
              const res = await fetch(`/api/areas/${entityId}`, { method: "DELETE", headers: { "content-type": "application/json" } })
              if (res.ok) {
                const areaGroup = nav.querySelector(`[data-area-group="${entityId}"]`) as HTMLElement | null
                if (areaGroup) {
                  areaGroup.style.opacity = "0"
                  areaGroup.style.transition = "opacity 200ms ease"
                  setTimeout(() => areaGroup.remove(), 200)
                }
                showToast(i18n("sidebar.area_deleted", "Area deleted"), "success")
              }
              else showToast(i18n("sidebar.error_delete_failed", "Failed to delete"), "error")
            } catch { showToast(i18n("sidebar.error_delete_failed", "Failed to delete"), "error") }
          },
        )
      }
    }, { signal: areaActions.signal })

    // ── 5. Project ⋯ menu ──
    async function showProjectMenu(btn: HTMLButtonElement, focusEdit: boolean) {
      if (!projectMenuDropdown) return
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(btn.dataset.projectMenu ?? "")}`)
        if (!response.ok) throw new Error("Unavailable")
        const record = await response.json() as { icon?: string; color?: string }
        if (!btn.isConnected || areaActions.signal.aborted) return
        btn.dataset.projectIconValue = record.icon ?? "📋"
        btn.dataset.projectColor = record.color ?? "#146C4E"
      } catch { showToast("This work is unavailable. Refresh the Board to try again.", "error"); return }

      const isVisible = ctrl.isShowing(projectMenuDropdown) && activeEntityId === btn.dataset.projectMenu && activeEntityType === "project"
      ctrl.hideAll()
      if (isVisible) return
      activeEntityType = "project"
      activeEntityOwner = ownerFor("project", btn.dataset.projectMenu ?? "")
      activeEntityId = btn.dataset.projectMenu!
      activeEntityName = btn.dataset.projectTitle || ""
      const editLink = projectMenuDropdown.querySelector<HTMLAnchorElement>("[data-action='manage']")
      if (editLink) editLink.href = safeIngressHref(boardWorkspaceHref(entityBoard("project", activeEntityId), { project: activeEntityId, groups: true }, "project-settings"))
      for (const item of projectMenuDropdown.querySelectorAll<HTMLElement>("[data-action]")) {
        const action = item.dataset.action
        item.hidden = action !== "manage" && !allowed("project", activeEntityId, action === "delete" ? "delete" : "edit")
      }
      ctrl.show(projectMenuDropdown, btn)
      if (focusEdit) editLink?.focus()
    }
    projectMenuDropdown?.addEventListener("click", async (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
      if (!target || !activeEntityId || activeEntityType !== "project") return
      const action = target.dataset.action
      const entityId = activeEntityId
      const entityName = activeEntityName || ""

      if (action === "manage") return
      if (action === "rename") {
        ctrl.hideAll()
        const linkEl = nav.querySelector<HTMLElement>(`.stree__project [data-project-id="${entityId}"] .stree__project-name`)
        if (!linkEl) return
        const container = linkEl.closest<HTMLElement>(".stree__project")!
        showInlineInput(
          container,
          i18n("sidebar.new_project_placeholder", "Project name\u2026"),
          entityName,
          async (newTitle) => {
            try {
              const res = await fetch(`/api/projects/${entityId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: newTitle }) })
              if (res.ok) {
                linkEl.textContent = newTitle
                const link = linkEl.closest<HTMLAnchorElement>("[data-project-id]")
                if (link) {
                  link.dataset.projectName = newTitle
                  link.title = newTitle
                }
                const menu = container.querySelector<HTMLButtonElement>("[data-project-menu]")
                if (menu) {
                  menu.dataset.projectTitle = newTitle
                  menu.setAttribute("aria-label", `${menu.title} - ${newTitle}`)
                }
                const add = container.querySelector<HTMLButtonElement>("[data-task-add-project]")
                if (add) {
                  add.dataset.taskAddName = newTitle
                  add.setAttribute("aria-label", `Add task to ${newTitle}`)
                }
                if (activeEntityType === "project" && activeEntityId === entityId) activeEntityName = newTitle
                renderPinned()
              }
              else showToast(i18n("sidebar.error_update_failed", "Failed to update"), "error")
            } catch { showToast(i18n("sidebar.error_update_failed", "Failed to update"), "error") }
          },
          container.querySelector<HTMLElement>("[data-project-menu]"),
        )
      }
      if (action === "color-icon") {
        ctrl.hide()
        if (!colorIconPopover) return
        const triggerBtn = nav.querySelector<HTMLButtonElement>(`[data-project-menu="${entityId}"]`)
        const currentIcon = triggerBtn?.dataset.projectIconValue || "\ud83d\udccb"
        const currentColor = triggerBtn?.dataset.projectColor || "#146C4E"
        // Sync icon preview + hidden input
        const iconInput = colorIconPopover.querySelector<HTMLInputElement>("#entity-icon-input")
        const iconPreview = colorIconPopover.querySelector<HTMLSpanElement>("#entity-icon-preview")
        if (iconInput) iconInput.value = currentIcon
        if (iconPreview) renderIconOrCustomEmoji(iconPreview, currentIcon, "folders", 18)
        // Sync swatch selection
        colorIconPopover.querySelectorAll<HTMLButtonElement>("[data-swatch-color]").forEach((s) => s.classList.toggle("selected", s.dataset.swatchColor === currentColor))
        // Reset emoji tab to first
        colorIconPopover.querySelectorAll<HTMLButtonElement>("[data-emoji-tab]").forEach((t, i) => t.classList.toggle("active", i === 0))
        colorIconPopover.querySelectorAll<HTMLElement>("[data-emoji-panel]").forEach((p, i) => p.classList.toggle("hidden", i !== 0))
        if (triggerBtn) {
          ctrl.show(colorIconPopover, triggerBtn)
          colorIconPopover.querySelector<HTMLElement>(".stree__emoji-tab")?.focus()
        }
      }
      if (action === "delete") {
        ctrl.hideAll()
        const projRow = nav.querySelector(`.stree__project [data-project-id="${entityId}"]`)?.closest(".stree__project") as HTMLElement | null
        if (!projRow) return
        showInlineConfirm(
          projRow,
          i18n("sidebar.delete_confirm_btn", "Confirm Delete"),
          async () => {
            try {
              const res = await fetch(`/api/projects/${entityId}`, { method: "DELETE", headers: { "content-type": "application/json" } })
              if (res.ok) {
                const projRow = nav.querySelector(`.stree__project [data-project-id="${entityId}"]`)?.closest(".stree__project") as HTMLElement | null
                if (projRow) {
                  projRow.style.opacity = "0"
                  projRow.style.transition = "opacity 200ms ease"
                  setTimeout(() => {
                    projRow.remove()
                    // Remove from pinned if present
                    pinnedIds.delete(pinKey(entityId))
                    savePinned()
                    renderPinned()
                  }, 200)
                }
                showToast(i18n("sidebar.project_deleted", "Project deleted"), "success")
              }
              else showToast(i18n("sidebar.error_delete_failed", "Failed to delete"), "error")
            } catch { showToast(i18n("sidebar.error_delete_failed", "Failed to delete"), "error") }
          },
        )
      }
    }, { signal: areaActions.signal })

    // ── 6. Color swatch + save (shared) ──
    colorIconPopover?.querySelectorAll<HTMLButtonElement>("[data-swatch-color]").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        colorIconPopover!.querySelectorAll<HTMLButtonElement>("[data-swatch-color]").forEach((s) => s.classList.remove("selected"))
        swatch.classList.add("selected")
      }, { signal: areaActions.signal })
    })

    // ── 6b. Emoji picker tab switching + selection ──
    colorIconPopover?.querySelectorAll<HTMLButtonElement>("[data-emoji-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        colorIconPopover!.querySelectorAll<HTMLButtonElement>("[data-emoji-tab]").forEach((t) => t.classList.remove("active"))
        colorIconPopover!.querySelectorAll<HTMLElement>("[data-emoji-panel]").forEach((p) => p.classList.add("hidden"))
        tab.classList.add("active")
        const panel = colorIconPopover!.querySelector(`[data-emoji-panel="${tab.dataset.emojiTab}"]`)
        panel?.classList.remove("hidden")
      }, { signal: areaActions.signal })
    })
    colorIconPopover?.querySelectorAll<HTMLButtonElement>("[data-emoji-value]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preview = colorIconPopover!.querySelector<HTMLSpanElement>("#entity-icon-preview")
        const input = colorIconPopover!.querySelector<HTMLInputElement>("#entity-icon-input")
        if (preview) renderIconOrCustomEmoji(preview, btn.dataset.emojiValue, "checklist", 18)
        if (input) input.value = btn.dataset.emojiValue!
        colorIconPopover!.querySelectorAll<HTMLButtonElement>("[data-emoji-value]").forEach((b) => b.classList.remove("selected"))
        btn.classList.add("selected")
      }, { signal: areaActions.signal })
    })

    colorIconPopover?.querySelector<HTMLButtonElement>("#color-icon-save")?.addEventListener("click", async () => {
      if (!activeEntityId) return
      const entityId = activeEntityId
      const iconInput = colorIconPopover!.querySelector<HTMLInputElement>("#entity-icon-input")
      const selectedSwatch = colorIconPopover!.querySelector<HTMLButtonElement>("[data-swatch-color].selected")
      const icon = iconInput?.value?.trim() || "\ud83d\udccb"
      const color = selectedSwatch?.dataset.swatchColor || "#146C4E"
      closeTreePopup()
      const endpoint = activeEntityType === "area" ? `/api/areas/${entityId}` : `/api/projects/${entityId}`
      try {
        const res = await fetch(endpoint, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ icon, color }),
        })
        if (res.ok) {
          // Update icon and color in sidebar DOM directly
          if (activeEntityType === "area") {
            const iconEl = nav.querySelector(`[data-area-toggle="${entityId}"] .stree__area-icon`) as HTMLElement | null
            const menuBtn = document.querySelector(`[data-area-menu="${entityId}"]`) as HTMLElement | null
            if (iconEl) { renderIconOrCustomEmoji(iconEl, icon, "folders", 15); iconEl.style.color = color }
            if (menuBtn) { menuBtn.dataset.areaIcon = icon; menuBtn.dataset.areaColor = color }
          } else {
            const iconEl = nav.querySelector<HTMLElement>(`.stree__project [data-project-id="${entityId}"] .stree__project-icon`)
            const menuBtn = nav.querySelector(`[data-project-menu="${entityId}"]`) as HTMLElement | null
            if (iconEl) { renderIconOrCustomEmoji(iconEl, icon, "checklist", 14); iconEl.style.color = color }
            if (menuBtn) { menuBtn.dataset.projectIconValue = icon; menuBtn.dataset.projectColor = color }
            renderPinned()
          }
          showToast(i18n("sidebar.updated", "Updated"), "success")
        }
        else showToast(i18n("sidebar.error_update_failed", "Failed to update"), "error")
      } catch { showToast(i18n("sidebar.error_update_failed", "Failed to update"), "error") }
    }, { signal: areaActions.signal })

    // ── 7. Per-project task add (+) with kind picker — inline input ──
    function showTaskKind(btn: HTMLButtonElement) {
      const projectId = btn.dataset.taskAddProject
      if (!taskKindDropdown || !projectId) return
      const isVisible = ctrl.isShowing(taskKindDropdown) && activeProjectIdForTask === projectId
      ctrl.hideAll()
      if (isVisible) return
      activeProjectIdForTask = projectId
      activeEntityOwner = ownerFor("project", projectId)
      ctrl.show(taskKindDropdown, btn)
      taskKindDropdown.querySelector<HTMLButtonElement>("[data-task-kind]")?.focus()
    }

    taskKindDropdown?.addEventListener("click", async (e) => {
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-task-kind]")
      if (!target || !activeProjectIdForTask) return
      const kind = target.dataset.taskKind!
      const projId = activeProjectIdForTask
      ctrl.hideAll()
      // Use inline input instead of prompt()
      const projEl = nav.querySelector(`.stree__project [data-project-id="${projId}"]`)
      const projRow = projEl?.closest(".stree__project") as HTMLElement | null
      if (!projRow) return
      // Resolve area_id from DOM hierarchy
      const areaGroup = projRow.closest<HTMLElement>("[data-area-group]")
      const areaId = areaGroup?.dataset.areaGroup || null

      showInlineInput(
        projRow,
        i18n("sidebar.new_task_placeholder", "Task title\u2026"),
        "",
        async (title) => {
          try {
            const res = await fetch("/api/tasks", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title,
                project_id: projId,
                area_id: areaId,
                task_kind: kind,
              }),
            })
            if (res.ok) {
              updateProjectTaskCount(projId)
              showToast(i18n("sidebar.task_created", `Task created in project`), "success")
            } else {
              showToast(i18n("sidebar.error_create_failed", "Failed to create"), "error")
            }
          } catch { showToast(i18n("sidebar.error_create_failed", "Failed to create"), "error") }
        },
        projRow.querySelector<HTMLElement>("[data-task-add-project]"),
      )
    }, { signal: areaActions.signal })

    // ── 8. New Area button — inline input ──
    // ── 9. Keyboard navigation (enhanced with Escape close) ──
    const focusables = () =>
      Array.from(nav.querySelectorAll<HTMLElement>(
        ".stree__project-link, .stree__area-toggle"
      )).filter((el) => el.offsetParent !== null && !el.closest("[inert]"))

    nav.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      // Dismiss this hierarchy's popup before handing Escape to an outer disclosure.
      if (e.key === "Escape") { dismissTreePopup(e); return }
      const target = e.target as HTMLElement
      if (!target.matches(".stree__project-link, .stree__area-toggle")) return
      // More owns the continuous vertical sequence across the complete hierarchy.
      if (target.closest("[data-nav-overflow-menu]") && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return
      const items = focusables()
      const idx = items.indexOf(target)
      if (idx === -1) return
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); if (idx < items.length - 1) items[idx + 1]!.focus(); break
        case "ArrowUp": e.preventDefault(); if (idx > 0) items[idx - 1]!.focus(); break
        case "Enter": case " ":
          if (target.matches(".stree__project-link")) { e.preventDefault(); (target as HTMLAnchorElement).click() }
          break
        case "Home": e.preventDefault(); if (items.length > 0) items[0]!.focus(); break
        case "End": e.preventDefault(); if (items.length > 0) items[items.length - 1]!.focus(); break
      }
    }, { signal: areaActions.signal })

    // ── 10. Project task counts (batched, non-blocking) ──
    async function updateProjectTaskCount(projectId: string, signal: AbortSignal = areaActions.signal) {
      if (signal.aborted || areaActions.signal.aborted) return
      const badge = nav.querySelector<HTMLSpanElement>(`[data-project-task-count="${CSS.escape(projectId)}"]`)
      if (!badge) return
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}?task_counts=1`, { signal })
        if (!res.ok) return
        const data = await res.json()
        const counts = data?.task_counts
        if (!signal.aborted && badge.isConnected && typeof counts?.active_open === "number") {
          badge.textContent = String(counts.active_open)
          badge.dataset.loaded = "true"
          // P3-18: Completion celebration — pulse when all tasks done
          badge.classList.toggle("stree__count--done", counts.total > 0 && counts.complete === counts.total)
        }
      } catch { /* non-critical: task count fetch failed silently */ }
    }

    // Fetch counts with staggered delay to avoid thundering herd
    const countBadges = Array.from(nav.querySelectorAll<HTMLElement>("[data-project-task-count]"))
    countBadges.forEach((badge, i) => {
      const projectId = badge.dataset.projectTaskCount
      if (!projectId) return
      const timer = setTimeout(() => {
        countTimers.delete(timer)
        void updateProjectTaskCount(projectId)
      }, i * 50)
      countTimers.add(timer)
    })
    window.addEventListener(TASK_COUNTS_CHANGED, event => {
      const ids = (event as CustomEvent<{ projectIds?: string[] }>).detail?.projectIds ?? []
      for (const id of ids) void updateProjectTaskCount(id)
    }, { signal: areaActions.signal })

    // Layout owns the global New Task shortcut; these controls retain explicit Project capture.

    function newArea(owner: HTMLElement, created: () => void) {
      if (!owner.dataset.workActions?.split(" ").includes("area/create")) return
      showInlineInput(owner, i18n("sidebar.new_area_placeholder", "Area name…"), "", async name => {
        try {
          const response = await command(owner, "/api/areas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })
          if (!response.ok) throw new Error("Unconfirmed")
          if (owner.isConnected) created()
        } catch { showToast("Could not confirm the Area. Refresh before trying again.", "error") }
      }, owner.querySelector<HTMLElement>("[data-board-new-area]"))
    }
    const api: SidebarHierarchyActions = { insertAreaNode, insertProjectNode, newArea, refresh: () => {
      renderPinned()
      for (const badge of nav.querySelectorAll<HTMLElement>("[data-project-task-count]:not([data-loaded])")) {
        if (badge.dataset.projectTaskCount) void updateProjectTaskCount(badge.dataset.projectTaskCount)
      }
    }, dispose: () => areaActions.abort() }
    host.__meithealHierarchyActions = { nav, signal: pageSignal, controller: areaActions, api }
    return api
}
