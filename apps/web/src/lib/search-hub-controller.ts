import { createFocusTrap } from "@lib/focus-trap"
import { workerAllowsNetworkOnly } from "@lib/network-only-worker"
import { fetchOnlineSearch, searchRegistration, searchWorkerReady, searchWorkerScope } from "@lib/online-search-client"
import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
import { pageLifecycle } from "@lib/page-lifecycle"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { EXACT_TASK_IDENTIFIER_SCORE } from "@lib/task-search-score"
import type {
  SearchResponse,
  SearchResultItem,
  SearchResultSection,
  SearchScope,
  TaskSearchField,
} from "@domains/search/search-types"

const waitingSearchCapability = "MEITHEAL_SEARCH_WAITING_CAPABLE"

async function waitingSearchWorker(scope: URL) {
  const waiting = (await searchRegistration(scope))?.waiting
  if (waiting?.scriptURL === new URL("sw.js", scope).href &&
      await workerAllowsNetworkOnly(waiting, waitingSearchCapability)) return waiting
  return undefined
}

interface StaticRegistry {
  pages: SearchResultItem[]
  actions: SearchResultItem[]
}

interface SearchReturn {
  taskId: string
  prefill: string
  scope: SearchScope
  trigger: HTMLElement | null
}

function getStaticRegistry(): StaticRegistry {
  const raw = document.getElementById("search-hub-static")?.textContent ?? "{}"

  try {
    return JSON.parse(raw) as StaticRegistry
  } catch {
    return { pages: [], actions: [] }
  }
}

function itemMatchesQuery(item: SearchResultItem, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return [item.title, item.subtitle, item.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(needle)
}

const TABLER_SEARCH_ICONS = {
  task: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3l8 -8" /><path d="M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9" /></svg>`,
  area: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" /></svg>`,
  saved_filter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z" /></svg>`,
  setting: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /></svg>`,
  action: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" /></svg>`,
  page: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l14 0" /><path d="M13 18l6 -6" /><path d="M13 6l6 6" /></svg>`,
  calendar: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12" /><path d="M16 3v4" /><path d="M8 3v4" /><path d="M4 11h16" /></svg>`,
  table: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z" /><path d="M3 10h18" /><path d="M10 3v18" /></svg>`,
  kanban: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l6 0" /><path d="M14 4l6 0" /><path d="M4 8m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" /><path d="M14 8m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" /></svg>`,
  default: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></svg>`,
} as const

function getIconSvgForItem(item: SearchResultItem): string {
  if (item.id === "page-calendar") return TABLER_SEARCH_ICONS.calendar
  if (item.id === "page-table") return TABLER_SEARCH_ICONS.table
  if (item.id === "page-tasks") return TABLER_SEARCH_ICONS.kanban
  switch (item.kind) {
    case "task":
      return TABLER_SEARCH_ICONS.task
    case "area":
      return TABLER_SEARCH_ICONS.area
    case "saved_filter":
      return TABLER_SEARCH_ICONS.saved_filter
    case "setting":
      return TABLER_SEARCH_ICONS.setting
    case "action":
      return TABLER_SEARCH_ICONS.action
    case "page":
      return TABLER_SEARCH_ICONS.page
    default:
      return TABLER_SEARCH_ICONS.default
  }
}

/** Ensure a URL is safe for navigation (only relative paths allowed) */
function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin)
    return u.origin === window.location.origin
  } catch {
    return false
  }
}

function prefixIngress(href: string): string {
  if (!href.startsWith("/")) return href
  return `${window.__ingress_path || ""}${href}`
}

function renderResultItem(
  item: SearchResultItem,
  index: number,
  onSelect: () => void,
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "search-hub-item"
  button.id = `search-hub-option-${index}`
  button.tabIndex = -1
  button.setAttribute("role", "option")
  button.setAttribute("aria-selected", "false")

  const icon = document.createElement("span")
  icon.className = "search-hub-item-icon"
  icon.setAttribute("aria-hidden", "true")
  if (item.color) {
    icon.style.boxShadow = `inset 0 0 0 1px rgba(var(--border-rgb), 0.4), 0 0 0 1px ${item.color}`
  }
  icon.innerHTML = getIconSvgForItem(item)

  const body = document.createElement("div")
  const title = document.createElement("p")
  title.className = "search-hub-item-title"
  title.textContent = item.title
  body.appendChild(title)

  if (item.subtitle) {
    const subtitle = document.createElement("p")
    subtitle.className = "search-hub-item-subtitle"
    subtitle.textContent = item.subtitle
    body.appendChild(subtitle)
  }

  if (item.description) {
    const description = document.createElement("p")
    description.className = "search-hub-item-description"
    description.textContent = item.description
    body.appendChild(description)
  }

  const meta = document.createElement("div")
  meta.className = "search-hub-item-meta"
  if (item.meta?.deferred === true) {
    const badge = document.createElement("span")
    badge.className = "search-hub-badge"
    badge.textContent = window.mI18n?.get("deferral.title") ?? "Deferred"
    meta.appendChild(badge)
  }
  const matchedFields = Array.isArray(item.meta?.matched_fields)
    ? (item.meta?.matched_fields as unknown[]).slice(0, 2).map((value) => String(value))
    : []
  for (const field of matchedFields) {
    const badge = document.createElement("span")
    badge.className = "search-hub-badge"
    badge.textContent = field
    meta.appendChild(badge)
  }

  button.append(icon, body, meta)
  button.addEventListener("click", onSelect)
  return button
}

async function searchCatalog(
  query: string,
  scope: SearchScope,
  taskFields: TaskSearchField[],
  includeCompleted: boolean,
  includeArchived: boolean,
  sort: string,
  ingressScope: URL,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    scope,
    limit: "8",
    sort,
    task_fields: taskFields.join(","),
  })
  if (query) params.set("q", query)
  if (includeCompleted) params.set("include_completed", "1")
  if (includeArchived) params.set("include_archived", "1")

  return fetchOnlineSearch(params, ingressScope, AbortSignal.any([signal, AbortSignal.timeout(8_000)]))
}

pageLifecycle.onPageLoad((signal) => {
  try {
  const launcher = document.getElementById("global-search") as HTMLInputElement | null
  const overlay = document.getElementById("search-hub-overlay") as HTMLDivElement | null
  const panel = overlay?.querySelector(".search-hub-panel") as HTMLElement | null
  const input = document.getElementById("search-hub-input") as HTMLInputElement | null
  const results = document.getElementById("search-hub-results") as HTMLDivElement | null
  const status = document.getElementById("search-hub-announcement")
  const recovery = document.getElementById("search-hub-recovery")
  const closeButton = document.getElementById("search-hub-close") as HTMLButtonElement | null
  const scopeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".search-hub-scope"))
  const taskOptions = document.getElementById("search-task-options") as HTMLDivElement | null
  const includeCompleted = document.getElementById("search-include-completed") as HTMLInputElement | null
  const includeArchived = document.getElementById("search-include-archived") as HTMLInputElement | null
  const sortSelect = document.getElementById("search-sort") as HTMLSelectElement | null
  const staticRegistry = getStaticRegistry()

  // The SearchHub modal must initialize even without a launcher input.
  // Pages using custom-header slot (e.g. settings) don't render TopNavigation,
  // so #global-search doesn't exist — but window.openSearchHub must still work.
  if (!overlay || !panel || !input || !results || !status || !recovery || !closeButton || overlay.dataset.searchController === "ready") {
    return
  }
  overlay.dataset.searchController = "ready"

  const launcherEl = launcher  // nullable — may not exist on custom-header pages
  const overlayEl = overlay
  const panelEl = panel
  const inputEl = input
  const resultsEl = results
  const recoveryEl = recovery
  const statusEl = status
  const closeButtonEl = closeButton

  const focusTrap = createFocusTrap(panelEl)
  let isOpen = false
  let activeScope: SearchScope = "all"
  let selectedIndex = -1
  let renderedItems: SearchResultItem[] = []
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchRequest: AbortController | null = null
  let suppressLauncherFocus = false
  let searchTrigger: HTMLElement | null = null
  let detailReturn: SearchReturn | undefined
  let returnSelection: string | undefined

  function updateScopeUI(): void {
    scopeButtons.forEach((button) => {
      const isActive = button.dataset.scope === activeScope
      button.classList.toggle("is-active", isActive)
      button.setAttribute("aria-selected", String(isActive))
    })
    if (taskOptions) {
      taskOptions.hidden = activeScope !== "all" && activeScope !== "tasks"
    }
  }

  function getTaskFields(): TaskSearchField[] {
    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-task-field]"),
    )
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.dataset.taskField as TaskSearchField)

    return fields.length > 0 ? fields : ["title"]
  }

  function setSelectedIndex(nextIndex: number): void {
    const buttons = Array.from(resultsEl.querySelectorAll<HTMLButtonElement>(".search-hub-item"))
    selectedIndex = buttons.length === 0 ? -1 : Math.max(0, Math.min(nextIndex, buttons.length - 1))
    buttons.forEach((button, index) => {
      button.classList.toggle("is-selected", index === selectedIndex)
      button.setAttribute("aria-selected", String(index === selectedIndex))
    })
    const selected = buttons[selectedIndex]
    if (selected) {
      inputEl.setAttribute("aria-activedescendant", selected.id)
      selected.scrollIntoView({ block: "nearest" })
      const optionRect = selected.getBoundingClientRect()
      const listRect = resultsEl.getBoundingClientRect()
      if (optionRect.bottom > listRect.bottom) {
        resultsEl.scrollTop += optionRect.bottom - listRect.bottom + 8
      } else if (optionRect.top < listRect.top) {
        resultsEl.scrollTop -= listRect.top - optionRect.top + 8
      }
    } else {
      inputEl.removeAttribute("aria-activedescendant")
    }
  }

  function invalidateResults(): void {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
    searchRequest?.abort()
    searchRequest = null
    renderedItems = []
    resultsEl.replaceChildren()
    statusEl.textContent = ""
    recoveryEl.replaceChildren()
    setSelectedIndex(-1)
  }

  function closeHub(restoreFocus = true): void {
    if (!isOpen) return
    isOpen = false
    overlayEl.classList.add("hidden")
    inputEl.setAttribute("aria-expanded", "false")
    invalidateResults()
    inputEl.value = ""
    if (launcherEl) launcherEl.value = ""
    returnSelection = undefined
    focusTrap.deactivate(false)
    if (restoreFocus) focusSearchTrigger(searchTrigger)
    searchTrigger = null
  }

  function focusSearchTrigger(trigger: HTMLElement | null): void {
    if (!trigger?.isConnected) return
    suppressLauncherFocus = true
    trigger.focus()
    suppressLauncherFocus = false
  }

  function runAction(actionId: string | undefined): void {
    if (!actionId) return
    if (actionId === "new-task") {
      document.dispatchEvent(new CustomEvent("meitheal:new-task"))
      return
    }
    if (actionId === "ask-home-assistant") {
      window.openAskHaModal?.()
    }
  }

  function selectItem(item: SearchResultItem): void {
    if (item.kind === "task" && item.taskId) {
      const snapshot = { taskId: item.taskId, prefill: inputEl.value, scope: activeScope, trigger: searchTrigger }
      detailReturn = snapshot
      closeHub(false)
      openTaskDetailHandoff(item.taskId, {
        onDismiss(reason) {
          if (signal.aborted || detailReturn !== snapshot) return
          detailReturn = undefined
          if (reason === "dismiss") openHub(snapshot, snapshot)
          else if (reason === "discard") focusSearchTrigger(snapshot.trigger)
        },
      })
      return
    }
    closeHub()
    if (item.kind === "action") {
      runAction(item.actionId)
      return
    }
    if (item.href) {
      const target = prefixIngress(item.href)
      if (isSafeUrl(target)) {
        const url = new URL(target, window.location.href)
        const settingsShell = document.getElementById("settings-shell")
        if (item.kind === "setting" && settingsShell && url.href === window.location.href) {
          settingsShell.dispatchEvent(new Event("meitheal:settings-jump"))
          return
        }
        window.location.href = target
      }
    }
  }

  function renderSections(sections: SearchResultSection[], exactFirst = false, restoredTaskId?: string): void {
    resultsEl.replaceChildren()
    statusEl.textContent = ""
    recoveryEl.replaceChildren()
    renderedItems = []

    if (sections.length === 0 || sections.every((section) => section.items.length === 0)) {
      setSelectedIndex(-1)
      statusEl.textContent = "No matching results yet"
      return
    }

    sections.forEach((section) => {
      if (section.items.length === 0) return

      const sectionEl = document.createElement("section")
      sectionEl.className = "search-hub-section"
      sectionEl.setAttribute("role", "group")

      const title = document.createElement("div")
      title.className = "search-hub-section-title"
      title.id = `search-hub-section-${section.id}`
      title.textContent = section.label
      sectionEl.setAttribute("aria-labelledby", title.id)
      sectionEl.appendChild(title)

      section.items.forEach((item) => {
        const itemIndex = renderedItems.push(item) - 1
        const button = renderResultItem(item, itemIndex, () => selectItem(item))
        sectionEl.appendChild(button)
      })

      resultsEl.appendChild(sectionEl)
    })

    const exactIndex = exactFirst ? renderedItems.findIndex(item =>
      item.kind === "task" && Number(item.meta?.score) >= EXACT_TASK_IDENTIFIER_SCORE,
    ) : -1
    const restoredIndex = restoredTaskId ? renderedItems.findIndex(item => item.taskId === restoredTaskId) : -1
    setSelectedIndex(restoredIndex >= 0 ? restoredIndex : Math.max(0, exactIndex))
  }

  function buildStaticSections(query: string): SearchResultSection[] {
    const sections: SearchResultSection[] = []

    if (activeScope === "all" || activeScope === "views") {
      const pages = staticRegistry.pages.filter((item) => itemMatchesQuery(item, query))
      if (pages.length > 0) {
        sections.push({
          id: "pages",
          label: query ? "Pages" : "Quick navigation",
          items: pages,
        })
      }
    }

    if (activeScope === "all" || activeScope === "actions") {
      const actions = staticRegistry.actions.filter((item) => itemMatchesQuery(item, query))
      if (actions.length > 0) {
        sections.push({
          id: "actions",
          label: "Actions",
          items: actions,
        })
      }
    }

    return sections
  }

  function showSearchStatus(message: string, label?: string, action?: () => void): void {
    statusEl.textContent = message
    recoveryEl.replaceChildren()
    if (label && action) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "search-hub-close"
      button.textContent = label
      button.addEventListener("click", action, { signal })
      recoveryEl.appendChild(button)
    }
  }

  async function refreshResults(): Promise<void> {
    if (!isOpen) return
    invalidateResults()

    const query = inputEl.value.trim()
    const staticSections = buildStaticSections(query)
    const sort = sortSelect?.value ?? "relevance"

    if (activeScope === "actions") {
      renderSections(staticSections)
      return
    }

    const request = new AbortController()
    searchRequest = request
    const scope = searchWorkerScope()
    const worker = navigator.serviceWorker?.controller ?? null
    const isCurrent = () => isOpen && searchRequest === request && !signal.aborted && !request.signal.aborted &&
      (navigator.serviceWorker?.controller ?? null) === worker && searchWorkerScope().href === scope.href
    showSearchStatus("Searching…")

    try {
      if (worker) {
        const ready = await searchWorkerReady(scope, worker)
        if (!isCurrent()) return
        if (!ready) {
          const waiting = await waitingSearchWorker(scope)
          if (!isCurrent()) return
          renderSections(staticSections)
          if (waiting) {
            showSearchStatus("Activate the update to search tasks and settings.", "Activate update", () => {
              void searchRegistration(scope).then(current => {
                if (!isCurrent()) return
                if (current?.waiting !== waiting) {
                  void refreshResults()
                  return
                }
                inputEl.focus()
                showSearchStatus("Activating search update…", "Retry", () => void refreshResults())
                waiting.postMessage({ type: "SKIP_WAITING" })
              }).catch(() => {
                if (isCurrent()) void refreshResults()
              })
            })
          } else {
            showSearchStatus("Online search is unavailable until the app updates.", "Retry", () => {
              void searchRegistration(scope).then(current => current?.update()).catch(() => {})
              void refreshResults()
            })
          }
          return
        }
      }
      if (!isCurrent()) return
      const response = await searchCatalog(
        query,
        activeScope,
        getTaskFields(),
        includeCompleted?.checked ?? false,
        includeArchived?.checked ?? false,
        sort,
        scope,
        request.signal,
      )
      if (isCurrent()) {
        renderSections([...staticSections, ...response.sections], sort === "relevance", returnSelection)
        returnSelection = undefined
      }
    } catch {
      if (!isCurrent()) return
      renderSections(staticSections)
      showSearchStatus("Search is unavailable right now.", "Retry", () => void refreshResults())
    }
  }

  function openHub(options?: string | { prefill?: string; scope?: string }, restored?: SearchReturn): void {
    if (detailReturn) return
    const prefill = typeof options === "string" ? options : options?.prefill ?? ""
    const scope = typeof options === "object" ? options?.scope : undefined

    if (scope) {
      const validScope = scopeButtons.find((b) => b.dataset.scope === scope)
      if (validScope) {
        activeScope = scope as SearchScope
      }
    }

    if (!isOpen) {
      isOpen = true
      searchTrigger = restored ? restored.trigger : document.activeElement instanceof HTMLElement ? document.activeElement : null
      returnSelection = restored?.taskId
      overlayEl.classList.remove("hidden")
      inputEl.setAttribute("aria-expanded", "true")
      focusTrap.activate()
    }

    if (prefill) {
      inputEl.value = prefill
    }

    updateScopeUI()
    queueMicrotask(() => {
      inputEl.focus()
      if (prefill) inputEl.setSelectionRange(prefill.length, prefill.length)
    })
    void refreshResults()
  }

  window.openSearchHub = openHub

  document.addEventListener("keydown", event => {
    if (event.defaultPrevented) return
    const target = event.target
    if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) return
    if (document.getElementById("task-detail-overlay")?.classList.contains("active")) return

    if (event.key === "/" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      && singleKeyShortcutsEnabled()) {
      event.preventDefault()
      const scope = document.getElementById("settings-bar")?.dataset.searchScope
      openHub(scope ? { scope } : undefined)
      return
    }

    if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      openHub()
    }
  }, { signal })

  // Launcher-specific event listeners — only bound when #global-search exists.
  // On pages with custom-header (settings), the UnifiedBar search launcher
  // opens the hub via window.openSearchHub() directly instead.
  if (launcherEl) {
    launcherEl.addEventListener("focus", () => {
      if (suppressLauncherFocus) return
      openHub()
    }, { signal })
    launcherEl.addEventListener("click", () => openHub(), { signal })
    launcherEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        openHub()
      }
    }, { signal })
  }

  closeButtonEl.addEventListener("click", () => closeHub(), { signal })
  overlayEl.addEventListener("click", (event) => {
    if (event.target === overlayEl) closeHub()
  }, { signal })

  inputEl.addEventListener("input", () => {
    returnSelection = undefined
    invalidateResults()
    showSearchStatus("Searching…")
    searchTimer = setTimeout(() => {
      void refreshResults()
    }, 120)
  }, { signal })

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex(selectedIndex + 1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex(selectedIndex - 1)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const selected = renderedItems[selectedIndex]
      if (selected) selectItem(selected)
    }
  }, { signal })

  panelEl.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || !isOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeHub()
  }, { signal })

  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    if (isOpen) void refreshResults()
  }, { signal })
  window.addEventListener("pagehide", () => {
    detailReturn = undefined
    closeHub(false)
  }, { signal })
  signal.addEventListener("abort", () => {
    delete overlayEl.dataset.searchController
    if (window.openSearchHub === openHub) delete window.openSearchHub
    detailReturn = undefined
    focusTrap.deactivate(false)
    invalidateResults()
  }, { once: true })

  scopeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      returnSelection = undefined
      activeScope = (button.dataset.scope as SearchScope) || "all"
      updateScopeUI()
      void refreshResults()
    }, { signal })
  })

  ;[
    ...Array.from(document.querySelectorAll<HTMLInputElement>("[data-task-field]")),
    includeCompleted,
    includeArchived,
    sortSelect,
  ]
    .filter(Boolean)
    .forEach((element) => {
      element?.addEventListener("change", () => {
        returnSelection = undefined
        void refreshResults()
      }, { signal })
    })

  updateScopeUI()
  } catch (e) { console.error("[Meitheal][search] Boot failed", e) }
})
