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

function getIconForItem(item: SearchResultItem): string {
  if (item.icon) return item.icon
  switch (item.kind) {
    case "task":
      return "✓"
    case "area":
      return "▦"
    case "saved_filter":
      return "⌘"
    case "setting":
      return "⚙"
    case "action":
      return "✦"
    case "page":
      return "→"
    default:
      return "•"
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

function createEmptyState(message: string): HTMLElement {
  const empty = document.createElement("div")
  empty.className = "search-hub-empty"
  const announcement = document.createElement("span")
  announcement.setAttribute("role", "status")
  announcement.textContent = message
  empty.appendChild(announcement)
  return empty
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
  icon.textContent = getIconForItem(item)

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
  const status = document.getElementById("search-hub-status")
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
  if (!overlay || !panel || !input || !results || !status || !closeButton || overlay.dataset.searchController === "ready") {
    return
  }
  overlay.dataset.searchController = "ready"

  const launcherEl = launcher  // nullable — may not exist on custom-header pages
  const overlayEl = overlay
  const panelEl = panel
  const inputEl = input
  const resultsEl = results
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
    statusEl.replaceChildren()
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
    statusEl.replaceChildren()
    renderedItems = []

    if (sections.length === 0 || sections.every((section) => section.items.length === 0)) {
      setSelectedIndex(-1)
      statusEl.appendChild(createEmptyState("No matching results yet"))
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
    const state = createEmptyState(message)
    if (label && action) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "search-hub-close"
      button.textContent = label
      button.addEventListener("click", action, { signal })
      state.appendChild(button)
    }
    statusEl.replaceChildren(state)
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
