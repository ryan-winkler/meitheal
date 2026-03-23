import { createFocusTrap } from "@lib/focus-trap"
import { pageLifecycle } from "@lib/page-lifecycle"
import type {
  SearchResponse,
  SearchResultItem,
  SearchResultSection,
  SearchScope,
  TaskSearchField,
} from "@domains/search/search-types"

// Window globals (typed in types/window.d.ts):
//   openSearchHub, closeSearchHub, __searchHubKeyboardBound

interface StaticRegistry {
  pages: SearchResultItem[]
  actions: SearchResultItem[]
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
  empty.textContent = message
  return empty
}

function renderResultItem(
  item: SearchResultItem,
  selected: boolean,
  onSelect: () => void,
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `search-hub-item${selected ? " is-selected" : ""}`

  const icon = document.createElement("span")
  icon.className = "search-hub-item-icon"
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

  const response = await fetch(`/api/search?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`)
  }

  return response.json() as Promise<SearchResponse>
}

pageLifecycle.onPageLoad((signal) => {
  try {
  const launcher = document.getElementById("global-search") as HTMLInputElement | null
  const overlay = document.getElementById("search-hub-overlay") as HTMLDivElement | null
  const panel = overlay?.querySelector(".search-hub-panel") as HTMLElement | null
  const input = document.getElementById("search-hub-input") as HTMLInputElement | null
  const results = document.getElementById("search-hub-results") as HTMLDivElement | null
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
  if (!overlay || !panel || !input || !results || !closeButton) {
    return
  }

  const launcherEl = launcher  // nullable — may not exist on custom-header pages
  const overlayEl = overlay
  const panelEl = panel
  const inputEl = input
  const resultsEl = results
  const closeButtonEl = closeButton

  const focusTrap = createFocusTrap(panelEl)
  let isOpen = false
  let activeScope: SearchScope = "all"
  let selectedIndex = -1
  let renderedItems: SearchResultItem[] = []
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let suppressLauncherFocus = false

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
    })
  }

  function closeHub(): void {
    if (!isOpen) return
    isOpen = false
    overlayEl.classList.add("hidden")
    renderedItems = []
    selectedIndex = -1
    inputEl.value = ""
    if (launcherEl) launcherEl.value = ""
    suppressLauncherFocus = true
    focusTrap.deactivate()
    setTimeout(() => {
      suppressLauncherFocus = false
    }, 0)
  }

  function runAction(actionId: string | undefined): void {
    if (!actionId) return
    if (actionId === "new-task") {
      document.dispatchEvent(new CustomEvent("meitheal:new-task"))
      return
    }
    if (actionId === "ask-home-assistant") {
      const askButton = document.getElementById("ask-ha-btn") as HTMLButtonElement | null
      askButton?.click()
    }
  }

  function selectItem(item: SearchResultItem): void {
    closeHub()
    if (item.kind === "task" && item.taskId && typeof window.openTaskDetail === "function") {
      window.openTaskDetail(item.taskId)
      return
    }
    if (item.kind === "action") {
      runAction(item.actionId)
      return
    }
    if (item.href) {
      const target = prefixIngress(item.href)
      if (isSafeUrl(target)) {
        window.location.href = target
      }
    }
  }

  function renderSections(sections: SearchResultSection[]): void {
    resultsEl.innerHTML = ""
    renderedItems = []

    if (sections.length === 0 || sections.every((section) => section.items.length === 0)) {
      resultsEl.appendChild(createEmptyState("No matching results yet"))
      return
    }

    sections.forEach((section) => {
      if (section.items.length === 0) return

      const sectionEl = document.createElement("section")
      sectionEl.className = "search-hub-section"

      const title = document.createElement("div")
      title.className = "search-hub-section-title"
      title.textContent = section.label
      sectionEl.appendChild(title)

      section.items.forEach((item) => {
        const itemIndex = renderedItems.push(item) - 1
        const button = renderResultItem(item, itemIndex === selectedIndex, () => selectItem(item))
        sectionEl.appendChild(button)
      })

      resultsEl.appendChild(sectionEl)
    })

    setSelectedIndex(0)
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

  async function refreshResults(): Promise<void> {
    if (!isOpen) return

    const query = inputEl.value.trim()
    const taskFields = getTaskFields()
    const staticSections = buildStaticSections(query)

    if (activeScope === "actions") {
      renderSections(staticSections)
      return
    }

    resultsEl.innerHTML = ""
    resultsEl.appendChild(createEmptyState("Searching..."))

    try {
      const response = await searchCatalog(
        query,
        activeScope,
        taskFields,
        includeCompleted?.checked ?? false,
        includeArchived?.checked ?? false,
        sortSelect?.value ?? "relevance",
      )

      renderSections([...staticSections, ...response.sections])
    } catch {
      resultsEl.innerHTML = ""
      if (!query) {
        resultsEl.appendChild(createEmptyState("Start typing to search..."))
      } else {
        resultsEl.appendChild(createEmptyState("Search is unavailable right now"))
      }
    }
  }

  function openHub(options?: string | { prefill?: string; scope?: string }): void {
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
      overlayEl.classList.remove("hidden")
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
  window.closeSearchHub = closeHub

  if (!window.__searchHubKeyboardBound) {
    window.__searchHubKeyboardBound = true
    document.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName ?? ""
      const isEditing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(tag) ||
        target?.contentEditable === "true"

      if (isEditing) return

      if (event.key === "/" && !event.shiftKey) {
        event.preventDefault()
        window.openSearchHub?.()
        return
      }

      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        window.openSearchHub?.()
      }
    })
  }

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

  closeButtonEl.addEventListener("click", closeHub, { signal })
  overlayEl.addEventListener("click", (event) => {
    if (event.target === overlayEl) closeHub()
  }, { signal })

  inputEl.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer)
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
    if (event.key === "Enter" && renderedItems[selectedIndex]) {
      event.preventDefault()
      selectItem(renderedItems[selectedIndex]!)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      closeHub()
    }
  }, { signal })

  scopeButtons.forEach((button) => {
    button.addEventListener("click", () => {
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
        void refreshResults()
      }, { signal })
    })

  updateScopeUI()
  } catch (e) { console.error("[Meitheal][search] Boot failed", e) }
})
