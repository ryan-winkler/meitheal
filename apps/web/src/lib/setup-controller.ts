import { safeIngressHref, syncIngressDestination } from "./ingress-navigation"
import { safeFetch } from "./safe-fetch"
import { closeTablerModal, openTablerModal } from "./tabler-modal"
import { applyTheme, readAppearanceValue, readStoredThemeMode } from "./theme-watcher"
import { DASHBOARD_PATH, TASKS_START_PATH } from "./workspace-entry"
import { isWorkspaceTheme, readWorkspacePreferences, saveWorkspacePreferences, type WorkspacePreferences } from "./workspace-preferences"

function bindAccessReview(root: HTMLElement, signal: AbortSignal): () => void {
  const details = root.querySelector<HTMLDetailsElement>("[data-setup-permissions]")
  const list = root.querySelector<HTMLUListElement>("[data-setup-board-roles]")
  const status = root.querySelector<HTMLElement>("[data-setup-access-status]")
  if (!details || !list || !status) return () => {}
  let active: AbortController | undefined

  const clear = () => {
    active?.abort()
    list.replaceChildren()
    status.textContent = ""
  }
  const read = async () => {
    clear()
    if (!details.open || details.closest("[hidden]") || document.hidden || signal.aborted) return
    const request = new AbortController()
    active = request
    status.textContent = status.dataset.loading ?? ""
    try {
      const response = await safeFetch("/api/boards", {
        cache: "no-store", signal: AbortSignal.any([signal, request.signal]), timeoutMs: 5_000,
      })
      if (!response.ok || response.headers.get("x-meitheal-board-session") !== details.dataset.boardSession) {
        throw new Error("Board access unavailable")
      }
      const body = await response.json() as { boards?: { name?: unknown; role?: unknown }[] }
      if (request.signal.aborted || signal.aborted) return
      if (!Array.isArray(body.boards)) throw new Error("Board access unavailable")
      for (const board of body.boards) {
        if (!board || typeof board.name !== "string" ||
          (board.role !== "owner" && board.role !== "member" && board.role !== "viewer")) continue
        const item = document.createElement("li")
        item.textContent = `${board.name} · ${list.dataset[board.role]}`
        list.append(item)
      }
      status.textContent = list.childElementCount ? "" : status.dataset.empty ?? ""
    } catch {
      if (!request.signal.aborted && !signal.aborted) status.textContent = status.dataset.unavailable ?? ""
    }
  }
  const refresh = () => { void read() }
  details.addEventListener("toggle", refresh, { signal })
  document.addEventListener("visibilitychange", refresh, { signal })
  window.addEventListener("focus", refresh, { signal })
  window.addEventListener("pagehide", clear, { signal })
  window.addEventListener("offline", clear, { signal })
  window.addEventListener("online", refresh, { signal })
  return refresh
}

export function bindSetup(signal: AbortSignal): void {
  const root = document.querySelector<HTMLElement>("[data-workspace-setup]")
  const form = root?.querySelector<HTMLFormElement>("[data-setup-form]")
  const advanced = root?.querySelector<HTMLElement>("[data-setup-advanced]")
  const simple = root?.querySelector<HTMLElement>("[data-setup-simple]")
  const finish = root?.querySelector<HTMLButtonElement>("[data-setup-finish]")
  const skip = root?.querySelector<HTMLButtonElement>("[data-setup-skip]")
  const dialog = root?.querySelector<HTMLElement>("#setup-skip-modal")
  const error = root?.querySelector<HTMLElement>("[data-setup-error]")
  const progress = root?.querySelector<HTMLElement>("[data-setup-progress]")
  if (!root || !form || !advanced || !simple || !finish || !skip || !dialog || !error || !progress ||
    form.dataset.bound) return
  form.dataset.bound = "true"
  signal.addEventListener("abort", () => { delete form.dataset.bound }, { once: true })

  const theme = form.elements.namedItem("theme") as HTMLSelectElement
  const firstPage = form.elements.namedItem("firstPage") as HTMLSelectElement
  const capture = form.elements.namedItem("capture") as HTMLSelectElement
  const initial = readWorkspacePreferences()
  const originalTheme = readStoredThemeMode()
  const inheritedAuto = originalTheme === "auto" && !initial.theme && readAppearanceValue("meitheal-theme") === "auto"
  const keepTheme = inheritedAuto || !isWorkspaceTheme(originalTheme)
  theme.options.namedItem("keep-workspace-theme")!.hidden = !keepTheme
  theme.value = keepTheme ? "keep" : originalTheme
  firstPage.value = initial.firstPage ?? "dashboard"
  capture.value = initial.capture ?? "form"
  const edited = new Set<string>()
  const refreshAccess = bindAccessReview(root, signal)

  form.addEventListener("change", event => {
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) return
    edited.add(event.target.name)
    if (event.target.name === "mode") {
      advanced.hidden = event.target.value !== "advanced"
      simple.hidden = !advanced.hidden
      finish.textContent = (advanced.hidden ? finish.dataset.simple : finish.dataset.advanced) ?? finish.textContent
      refreshAccess()
    }
    if (event.target === theme) {
      if (isWorkspaceTheme(theme.value)) applyTheme(theme.value, theme.value === "auto")
      else applyTheme()
    }
  }, { signal })

  const goToWorkspace = (target: string) => {
    syncIngressDestination(target)
    window.location.assign(safeIngressHref(target))
  }
  const preferenceDestination = () => readWorkspacePreferences().firstPage === "tasks" ? TASKS_START_PATH : DASHBOARD_PATH
  const saveChoices = async (changes: WorkspacePreferences): Promise<boolean> => {
    finish.disabled = skip.disabled = true
    const saved = await saveWorkspacePreferences(changes)
    if (signal.aborted) return false
    error.hidden = saved
    finish.disabled = skip.disabled = saved
    return saved
  }

  form.addEventListener("submit", async event => {
    event.preventDefault()
    if (finish.disabled) return
    const changes: WorkspacePreferences = { acknowledged: true }
    if (advanced.hidden || edited.has("firstPage")) changes.firstPage = !advanced.hidden && firstPage.value === "tasks" ? "tasks" : "dashboard"
    if (advanced.hidden || edited.has("capture")) changes.capture = advanced.hidden || capture.value === "quick" ? "quick" : "form"
    if (isWorkspaceTheme(theme.value) && (edited.has("theme") || (!initial.theme && !readAppearanceValue("meitheal-theme")))) {
      changes.theme = theme.value
    }
    if (!await saveChoices(changes)) return
    progress.hidden = false
    goToWorkspace(preferenceDestination())
  }, { signal })

  skip.addEventListener("click", () => {
    void openTablerModal(dialog, skip).catch(() => { if (!signal.aborted) error.hidden = false })
  }, { signal })
  dialog.querySelector("[data-setup-confirm-skip]")?.addEventListener("click", async () => {
    closeTablerModal(dialog)
    if (await saveChoices({ acknowledged: true })) goToWorkspace(preferenceDestination())
  }, { signal })
  form.inert = false
}
