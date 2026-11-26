import { currentTaskApiContext } from "./task-api"
import { browserUuid } from "./browser-uuid"
import { confirmDialog, type ConfirmOptions } from "./confirm-dialog"
import { safeIngressHref, syncIngressDestination } from "./ingress-navigation"
import { stripIngressPrefix } from "./ingress-state-persistence"
import { safeFetch } from "./safe-fetch"
import { updateBoardCustomFieldDefs, type CustomFieldDef } from "./custom-field-defs"
import { showToast } from "./toast"
import { normalizeBoardKey, suggestBoardKey, validateBoardKey } from "@domains/tasks/board-key"
import {
  DEFAULT_BACKGROUND_POLL_INTERVAL_MS,
  DEFAULT_VISIBILITY_RETURN_GAP_MS,
  describeVerificationPause,
  shouldRunBackgroundRecheck,
  type VerificationPauseReason,
} from "./board-verification-policy"
import { createSpriteIconElement } from "../generated/icon-registry"

class BoardRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function bindBoardPage(signal: AbortSignal, host?: HTMLElement) {
  const root = host ?? document.querySelector<HTMLElement>("[data-board-directory]")
  const status = host ? document.querySelector<HTMLElement>("[data-layout-board-expired]") : document.querySelector<HTMLElement>("[data-board-expired]")
  if (!root || !status || root.dataset.bound) return
  const { boardKey, boardVerify, boardSession, boardAuthority } = root.dataset
  if (!boardKey || !boardVerify || !boardSession) return
  root.dataset.bound = "true"

  const stale = document.createElement("div")
  stale.dataset.boardStale = ""
  stale.className = "alert alert-warning board-verification-banner"
  stale.setAttribute("role", "status")
  stale.hidden = true
  root.prepend(stale)

  const recovery = document.createElement("div")
  recovery.dataset.boardVerification = ""
  recovery.className = "alert alert-warning board-verification-banner"
  recovery.setAttribute("role", "status")
  recovery.hidden = true

  const recoveryIcon = document.createElement("span")
  recoveryIcon.className = "board-verification-banner__icon"
  recoveryIcon.setAttribute("aria-hidden", "true")
  recoveryIcon.appendChild(createSpriteIconElement("alert-triangle", { size: 18 }))

  const recoveryBody = document.createElement("div")
  recoveryBody.className = "board-verification-banner__body"
  const recoveryTitle = document.createElement("p")
  recoveryTitle.className = "board-verification-banner__title"
  const recoveryDetail = document.createElement("p")
  recoveryDetail.className = "board-verification-banner__detail"
  recoveryDetail.dataset.boardVerificationDetail = ""
  recoveryBody.append(recoveryTitle, recoveryDetail)

  const recoveryActions = document.createElement("div")
  recoveryActions.className = "board-verification-banner__actions"
  const retry = document.createElement("button")
  retry.type = "button"
  retry.className = "btn btn-primary btn-sm"
  retry.textContent = "Retry verification"
  const refreshPage = document.createElement("button")
  refreshPage.type = "button"
  refreshPage.className = "btn btn-ghost btn-sm"
  refreshPage.textContent = "Refresh page"
  recoveryActions.append(retry, refreshPage)

  const updateRecoveryReason = (reason: VerificationPauseReason, statusCode?: number) => {
    const copy = describeVerificationPause(reason, statusCode)
    recoveryTitle.textContent = copy.title
    recoveryDetail.textContent = copy.detail
    recovery.dataset.boardVerificationReason = reason
  }
  updateRecoveryReason("session")
  recovery.append(recoveryIcon, recoveryBody, recoveryActions)
  status.before(recovery)
  let expired = false
  let navigating = false
  let checking: AbortController | undefined
  let lastVerifiedAt = Date.now()
  const placeholder = document.createComment("")
  let retainedFocus: { element: HTMLElement; boardId: string; actorKey: string | undefined; moved: boolean } | undefined
  let movingToRecovery = false
  const markFocusMoved = (event: Event) => {
    if (!retainedFocus || !placeholder.isConnected || movingToRecovery) return
    const target = event.target
    if (target instanceof Node && recovery.contains(target)) return
    retainedFocus.moved = true
  }
  document.addEventListener("focusin", markFocusMoved, { signal })
  document.addEventListener("pointerdown", markFocusMoved, { signal })
  document.addEventListener("keydown", markFocusMoved, { signal })
  const holdsFocus = () => {
    const active = document.activeElement
    return !!active && active !== document.body &&
      (root.contains(active) || recovery.contains(active) || !!active.closest('[role="dialog"], [role="alertdialog"]'))
  }
  const focusRecovery = (owned: boolean) => {
    const active = document.activeElement
    if (!owned || (active && active !== document.body && active.isConnected && !(expired && recovery.contains(active)))) return
    const target = expired ? status.querySelector<HTMLElement>("[data-board-refresh]") : retry
    movingToRecovery = true
    target?.focus({ preventScroll: true })
    movingToRecovery = false
  }
  const detach = (owned = holdsFocus(), reason: VerificationPauseReason = "session", statusCode?: number) => {
    const active = document.activeElement
    const context = currentTaskApiContext()
    if (root.isConnected && owned && active instanceof HTMLElement && context && !recovery.contains(active)) {
      retainedFocus = { element: active, boardId: context.boardId, actorKey: context.actorKey, moved: false }
    }
    if (!expired) updateRecoveryReason(reason, statusCode)
    root.dispatchEvent(new Event("meitheal:board-hidden", { bubbles: true }))
    if (root.isConnected) root.replaceWith(placeholder)
    recovery.hidden = expired
    if (!expired) focusRecovery(owned)
  }
  const restore = () => {
    lastVerifiedAt = Date.now()
    if (placeholder.isConnected) placeholder.replaceWith(root)
    recovery.hidden = true
    root.dispatchEvent(new Event("meitheal:board-verified", { bubbles: true }))
    const saved = retainedFocus
    retainedFocus = undefined
    const context = currentTaskApiContext(), active = document.activeElement
    if (saved && !saved.moved && context?.boardId === saved.boardId && context.actorKey === saved.actorKey &&
      saved.element.isConnected && !saved.element.matches(":disabled") && !saved.element.closest("[hidden], [inert]") &&
      saved.element.getClientRects().length && (active === document.body || active === retry || (active && recovery.contains(active)))) saved.element.focus({ preventScroll: true })
  }
  const expire = () => {
    const owned = holdsFocus()
    expired = true
    retainedFocus = undefined
    root.dataset.boardExpired = "true"
    // Verification may already have detached root, so publication must not rely on bubbling.
    document.dispatchEvent(new CustomEvent("meitheal:board-revoked", { detail: { boardId: root.dataset.boardId } }))
    detach(owned)
    root.replaceChildren()
    recovery.hidden = true
    status.hidden = false
    focusRecovery(owned)
  }
  async function recheck(beforeRevealing = false) {
    if (expired || signal.aborted) return
    checking?.abort()
    if (beforeRevealing) detach(holdsFocus(), "session")
    if (document.hidden) return
    const active = new AbortController()
    checking = active
    try {
      const verifyUrl = new URL(boardVerify!, location.origin)
      if (verifyUrl.origin !== location.origin || !stripIngressPrefix(verifyUrl.pathname).startsWith("/api/boards")) {
        detach(holdsFocus(), "session")
        return
      }
      const timeoutSignal = AbortSignal.timeout(4_000)
      const response = await fetch(verifyUrl.pathname + verifyUrl.search, { // nosemgrep
        method: "HEAD", cache: "no-store",
        signal: AbortSignal.any([signal, active.signal, timeoutSignal]),
      })
      if (active.signal.aborted || signal.aborted || document.hidden) return
      if (response.ok && boardAuthority && response.headers.get("x-meitheal-board-authority") === boardAuthority) {
        const refreshedSession = response.headers.get("x-meitheal-board-session")
        if (refreshedSession) {
          root!.dataset.boardSession = refreshedSession
          const meta = document.querySelector<HTMLMetaElement>('meta[name="meitheal-work-session"]')
          if (meta) meta.content = refreshedSession
          root!.dispatchEvent(new CustomEvent("meitheal:board-session-updated", { bubbles: true, detail: { session: refreshedSession, boardId: root!.dataset.boardId } }))
        }
        restore()
        stale.hidden = response.headers.get("x-meitheal-board-view") === boardKey
        stale.textContent = stale.hidden ? "" : "This Board changed. Your input is kept on this page. Refresh when ready to load the latest versions."
      } else if (response.ok && !boardAuthority && response.headers.get("x-meitheal-board-view") === boardKey) restore()
      else if (response.ok || response.status === 403 || response.status === 404) expire()
      else detach(holdsFocus(), "server", response.status)
    } catch (error) {
      if (!active.signal.aborted && !signal.aborted) {
        const isTimeout = error instanceof DOMException && error.name === "TimeoutError"
        const reason: VerificationPauseReason = !navigator.onLine ? "offline" : isTimeout ? "timeout" : "server"
        detach(holdsFocus(), reason)
      }
    }
  }
  const timer = setInterval(() => {
    if (!shouldRunBackgroundRecheck({
      now: Date.now(),
      lastVerifiedAt,
      isHidden: document.hidden,
      isDetached: placeholder.isConnected,
    })) return
    void recheck()
  }, DEFAULT_BACKGROUND_POLL_INTERVAL_MS)
  retry.addEventListener("click", () => { void recheck(true) }, { signal })
  refreshPage.addEventListener("click", () => window.location.reload(), { signal })
  signal.addEventListener("abort", () => {
    clearInterval(timer)
    recovery.remove()
    delete root.dataset.bound
  }, { once: true })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      checking?.abort()
      return
    }
    if (placeholder.isConnected || Date.now() - lastVerifiedAt >= DEFAULT_VISIBILITY_RETURN_GAP_MS) {
      void recheck(placeholder.isConnected)
    }
  }, { signal })
  window.addEventListener("focus", () => {
    void recheck(placeholder.isConnected)
  }, { signal })
  window.addEventListener("offline", () => { checking?.abort(); detach(holdsFocus(), "offline") }, { signal })
  window.addEventListener("online", () => { void recheck(placeholder.isConnected) }, { signal })
  window.addEventListener("pagehide", event => {
    checking?.abort()
    if (event.persisted) detach(holdsFocus(), "session")
  }, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void recheck(true) }, { signal })
  status.querySelector("[data-board-refresh]")?.addEventListener("click", () => window.location.reload(), { signal })

  async function confirmBoard(options: ConfirmOptions) {
    const confirmation = new AbortController()
    const hide = () => confirmation.abort()
    root!.addEventListener("meitheal:board-hidden", hide, { signal })
    try {
      return await confirmDialog({ ...options, signal: AbortSignal.any([signal, confirmation.signal]) })
    } finally {
      root!.removeEventListener("meitheal:board-hidden", hide)
    }
  }

  const dest = root.querySelector<HTMLSelectElement>('[name="destination"]')
  const recipient = root.querySelector<HTMLElement>("[data-board-recipient]")
  let submission: { id: string; content: string } | undefined
  const showAssignment = () => {
    if (recipient) recipient.hidden = dest?.selectedOptions[0]?.dataset.recipient !== "true"
  }
  showAssignment()
  dest?.addEventListener("change", showAssignment, { signal })

  for (const form of root.querySelectorAll<HTMLFormElement>('[data-board-form="sharing"]')) {
    const visibility = form.querySelector<HTMLSelectElement>('[name="visibility"]')
    const sharedSettings = form.querySelector<HTMLFieldSetElement>("[data-board-shared-settings]")
    const showSharedSettings = () => {
      if (sharedSettings) sharedSettings.hidden = visibility?.value !== "shared"
    }
    showSharedSettings()
    visibility?.addEventListener("change", showSharedSettings, { signal })
  }

  for (const form of root.querySelectorAll<HTMLFormElement>('[data-board-form="create"], [data-board-form="ticket-prefix"]')) {
    const keyInput = form.querySelector<HTMLInputElement>("[data-board-key-input]")
    const preview = form.querySelector<HTMLElement>("[data-board-key-preview]")
    const nameInput = form.dataset.boardForm === "create" ? form.querySelector<HTMLInputElement>('[name="name"]') : null
    const currentKey = form.querySelector<HTMLInputElement>('[name="currentKey"]')?.value
    let userEditedKey = false
    const updatePreview = (raw: string) => {
      if (!preview) return
      const normalized = normalizeBoardKey(raw)
      const display = normalized || (currentKey ?? "KEY")
      const code = preview.querySelector("code")
      if (code) {
        code.textContent = currentKey && normalized && normalized !== currentKey
          ? `${currentKey}-1 → ${normalized}-1`
          : `${display}-1`
      }
    }
    keyInput?.addEventListener("input", () => {
      userEditedKey = keyInput.value.trim().length > 0
      const clean = normalizeBoardKey(keyInput.value)
      if (keyInput.value !== clean) keyInput.value = clean
      updatePreview(clean)
    }, { signal })
    nameInput?.addEventListener("input", () => {
      if (!keyInput || userEditedKey) return
      const suggested = nameInput.value.trim() ? suggestBoardKey(nameInput.value) : ""
      keyInput.value = suggested
      updatePreview(suggested)
    }, { signal })
  }

  async function jsonRequest(path: string, method: string, body: object) {
    const boardPath = /^boards\/([^/]+)(?:\/|$)/.exec(path)
    const response = await safeFetch("/api/" + path, {
      method, body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Meitheal-Board-Session": root!.dataset.boardSession!,
        ...(boardPath?.[1] ? { "X-Meitheal-Board-Id": decodeURIComponent(boardPath[1]) } : {}),
      },
      mode: "same-origin", redirect: "error", timeoutMs: 10_000, signal,
    })
    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok) {
      const message = typeof data?.error === "string" ? data.error : (typeof data?.detail === "string" ? data.detail : "")
      throw new BoardRequestError(message || "Could not save. Refresh your Board and try again.", response.status)
    }
    return { status: response.status, data }
  }

  const fragment = location.hash.slice(1)
  const initialSection = document.getElementById(fragment)
  if (initialSection instanceof HTMLDetailsElement) initialSection.open = true
  const leavePage = (boardId?: string | null) => {
    navigating = true
    for (const button of root!.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) button.disabled = true
    if (boardId === undefined) {
      window.location.reload()
      return
    }
    const path = boardId === null ? "/boards" : `/boards/${encodeURIComponent(boardId)}`
    const target = new URL(safeIngressHref(path), location.origin)
    if (target.origin === location.origin) window.location.assign(target.pathname + target.search + target.hash) // nosemgrep
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-board-form-refresh]")) {
    button.addEventListener("click", () => { if (!expired && root.isConnected) leavePage() }, { signal })
  }
  const keepPendingSave = (form: HTMLFormElement, feedback: HTMLElement | null, message: string) => {
    form.dataset.boardPending = "true"
    if (feedback) feedback.textContent = message
    const refresh = form.querySelector<HTMLButtonElement>("[data-board-form-refresh]")
    if (refresh) refresh.hidden = false
  }

  const current = new URL(location.href)
  if (/^\/boards\/[^/]+\/?$/.test(stripIngressPrefix(current.pathname)) && root.dataset.boardId &&
      ["groups", "projects", "goals", "routines", "group-settings", "project-settings"].includes(fragment)
      && current.searchParams.get("view") !== "groups") {
    current.searchParams.set("view", "groups")
    const target = current.pathname + current.search + current.hash
    syncIngressDestination(target)
    location.replace(target) // nosemgrep
    return
  }
  const panel = document.getElementById(fragment)
  if (panel instanceof HTMLDetailsElement) {
    panel.open = true
    panel.querySelector("summary")?.focus()
  }

  root.addEventListener("toggle", async event => {
    const disclosure = event.target
    if (!(disclosure instanceof HTMLDetailsElement) || !disclosure.matches("[data-board-filing]") ||
        !disclosure.open || disclosure.dataset.loaded || !root.dataset.boardId) return
    const form = disclosure.querySelector<HTMLFormElement>("form")!
    const areas = form.querySelector<HTMLSelectElement>('[name="areaId"]')!
    const projects = form.querySelector<HTMLSelectElement>('[name="projectId"]')!
    const status = form.querySelector<HTMLElement>("[data-board-feedback]")!
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    disclosure.dataset.loaded = "loading"
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(root.dataset.boardId)}?view=tasks&planning=1&ticket=${encodeURIComponent(form.dataset.ticketId ?? "")}`, { // nosemgrep
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]),
      })
      if (!response.ok) throw new Error("Could not load placement choices.")
      const { planning, tasks } = await response.json() as {
        tasks?: Array<{ placement?: { areaId?: string; projectId?: string } }>
        planning?: {
          areas: Array<{ id: string; name: string }>
          projects: Array<{ id: string; title: string; status: string; areaId: string | null }>
        }
      }
      if (signal.aborted || expired) return
      if (!planning) throw new Error("Could not load placement choices.")
      const placement = tasks?.[0]?.placement
      const placedProject = planning.projects.find(project => project.id === placement?.projectId)
      const currentGroup = placedProject?.areaId ?? placement?.areaId
      for (const area of planning.areas) areas.add(new Option(area.name, area.id, false, currentGroup === area.id))
      const renderProjects = () => {
        const selected = projects.value
        projects.replaceChildren(new Option("No Project", ""))
        for (const project of planning.projects) {
          if (project.status !== "active" || (areas.value && project.areaId !== areas.value)) continue
          projects.add(new Option(project.title, project.id, false, selected === project.id))
        }
      }
      renderProjects()
      if (placedProject) projects.value = placedProject.id
      areas.addEventListener("change", renderProjects, { signal })
      areas.disabled = projects.disabled = save.disabled = false
      disclosure.dataset.loaded = "true"
      status.textContent = ""
    } catch {
      delete disclosure.dataset.loaded
      if (!signal.aborted && !expired) status.textContent = "Could not load placement choices. Close and reopen to try again."
    }
  }, { capture: true, signal })

  root.addEventListener("submit", async event => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || !form.dataset.boardForm) return
    event.preventDefault()
    if (expired || signal.aborted || navigating || form.dataset.boardPending) return
    const { boardForm } = form.dataset
    const data = new FormData(form)
    const value = (name: string) => String(data.get(name) ?? "")
    const content = { title: value("title"), description: value("description") }
    const boardId = form.dataset.boardId || root.dataset.boardId
    const api = boardId ? `boards/${encodeURIComponent(boardId)}` : "boards"
    const feedback = form.querySelector<HTMLElement>("[data-board-feedback]")
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')
    if (!button || button.disabled || button.hidden) return
    if (boardForm === "planning" && value("action") === "retire" && !await confirmBoard({ message: "Remove this item from active planning?" })) return
    if (boardForm === "lifecycle" && value("action") === "retire" && !await confirmBoard({
      title: "Delete Board",
      message: `Delete ${value("boardName") || "this Board"}? Its work stays saved in Deleted Boards. Incoming work and Routines pause until you restore it.`,
      confirmText: "Delete Board",
      variant: "danger",
    })) return
    if (expired || signal.aborted || !root.isConnected || !form.isConnected) return
    button.disabled = true
    button.classList.add("btn-loading")
    form.setAttribute("aria-busy", "true")
    if (feedback) feedback.textContent = ""

    try {
      switch (boardForm) {
        case "rename":
        case "sharing": {
          const revision = Number(value("revision"))
          if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Refresh this Board before saving its settings.")
          const name = value("name").trim()
          if (boardForm === "rename" && (!name || name.length > 100)) throw new Error("Enter a Board name of up to 100 characters.")
          const result = await jsonRequest(api, "PATCH", boardForm === "rename"
            ? { action: "rename", name, revision }
            : { action: "sharing", visibility: value("visibility"), sharedRole: value("sharedRole"),
              sharedAdminManagement: data.has("sharedAdminManagement"), revision })
          if (result.data?.accessPending) {
            keepPendingSave(form, feedback, "Saved. Access is still being verified. Your input is kept here. Refresh Board to check the result.")
            return
          }
          break
        }
        case "ticket-prefix": {
          const revision = Number(value("revision"))
          if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Refresh this Board before changing its key.")
          const checked = validateBoardKey(value("ticketPrefix"))
          if (!checked.ok) throw new Error(checked.error)
          const previous = normalizeBoardKey(value("currentKey"))
          if (checked.key === previous) {
            if (feedback) feedback.textContent = `Board key is already ${checked.key}.`
            return
          }
          const approved = await confirmBoard({
            title: "Change Board key?",
            message: `Changing the Board key from ${previous} to ${checked.key} will rewrite every ticket number on this Board (for example ${previous}-30 becomes ${checked.key}-30). Saved links, bookmarks, and external automations using ${previous}-* may stop working. Continue?`,
            confirmText: `Change to ${checked.key}`,
            variant: "danger",
          })
          if (!approved) return
          const result = await jsonRequest(api, "PATCH", { action: "ticket-prefix", ticketPrefix: checked.key, revision })
          if (result.data?.accessPending) {
            keepPendingSave(form, feedback, "Saved. Access is still being verified. Your input is kept here. Refresh Board to check the result.")
            return
          }
          break
        }
        case "create": {
          const rawKey = value("ticketPrefix").trim()
          let ticketPrefix: string | undefined
          if (rawKey) {
            const checked = validateBoardKey(rawKey)
            if (!checked.ok) throw new Error(checked.error)
            ticketPrefix = checked.key
          }
          const { status, data: result } = await jsonRequest(api, "POST", {
            name: value("name"),
            preset: value("preset") || undefined,
            ...(ticketPrefix ? { ticketPrefix } : {}),
          })
          const id = result?.id
          if (status === 201 && typeof id === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && !result?.accessPending) {
            leavePage(id)
            return
          }
          if (status !== 202 || result?.accessPending !== true) throw new Error("Board creation unconfirmed")
          if (typeof id === "string") form.dataset.boardCreatedId = id
          keepPendingSave(form, feedback, "Board saved. Access is still being verified. Your input is kept here. Refresh Boards to check the result.")
          return
        }
        case "lifecycle": {
          const { data } = await jsonRequest(api, "PATCH", { action: value("action"), revision: Number(value("revision")) })
          if (data?.accessPending) {
            keepPendingSave(form, feedback, "Board saved. Access is still being verified. Your input is kept here. Refresh Boards to check the result.")
            return
          }
          leavePage(null)
          return
        }
        case "sidebar":
          await jsonRequest(api, "PATCH", { action: "sidebar", hidden: value("hidden") === "true" })
          break
        case "member":
          await jsonRequest(api, "PATCH", {
            action: "member", memberId: value("memberId"), role: value("role") === "remove" ? null : value("role"),
            denyCompletion: data.has("denyCompletion"), denyDeletion: data.has("denyDeletion"),
          })
          break
        case "agent":
          await jsonRequest(api, "PATCH", { action: "agent", tokenId: value("tokenId").trim(), enabled: value("enabled") === "true" })
          break
        case "policy":
          await jsonRequest(api, "PATCH", {
            action: "policy", denyCompletion: data.has("denyCompletion"),
            denyDeletion: data.has("denyDeletion"), denyAgentDeletion: data.has("denyAgentDeletion"),
          })
          break
        case "planning": {
          const linkedEntity = value("linkedEntity")
          const [entityType, linkedId] = linkedEntity.split("/", 2)
          const result = await jsonRequest(api + "/planning", "POST", {
            action: value("action"), ...content, areaId: value("areaId") || null, goalId: value("goalId") || null,
            ...(data.has("target") ? { target: JSON.parse(value("target")) } : {}),
            ...(linkedId ? { id: linkedId, entityType } : data.has("id") ? { id: value("id") } : {}),
            ...(data.has("entityType") ? { entityType: value("entityType") } : {}),
            ...(data.has("pillarId") ? { pillarId: value("pillarId"), nonNegotiable: data.has("nonNegotiable") } : {}),
            ...(data.has("enabled") ? { enabled: value("enabled") === "true" } : {}),
            ...(data.has("entity") ? { entity: value("entity") } : {}),
            ...(data.has("status") ? { status: value("status") } : {}),
            ...(data.has("icon") ? { icon: value("icon") } : {}),
            ...(data.has("color") ? { color: value("color") } : {}),
            ...(data.has("cadence") ? { cadence: value("cadence") } : {}),
            ...(data.has("projectId") ? { projectId: value("projectId") || null } : {}),
            ...(data.has("period") ? { period: value("period") } : {}),
          })
          if (result.data?.accessPending && feedback) {
            feedback.textContent = "Saved. Board access is still being verified."
            return
          }
          break
        }
        case "intake-create":
          await jsonRequest(api + "/intakes", "POST", {
            label: value("label"), laneId: value("laneId"), senderIds: data.getAll("senderIds"), recipientId: value("recipientId"),
          })
          break
        case "intake-toggle":
          await jsonRequest(api + "/intakes", "PATCH", { id: value("id"), enabled: value("enabled") === "true" })
          break
        case "custom-field-add":
        case "custom-field-remove": {
          const activeBoardId = root!.dataset.boardId
          const cfHeaders = {
            "X-Meitheal-Board-Session": root!.dataset.boardSession!,
            ...(activeBoardId ? { "X-Meitheal-Board-Id": activeBoardId } : {}),
          }
          try {
            await updateBoardCustomFieldDefs((currentFields): CustomFieldDef[] => {
              if (boardForm === "custom-field-remove") {
                const targetName = value("name")
                return currentFields.filter(f => f.name !== targetName)
              }
              const name = value("name").trim()
              if (!name) throw new Error("Enter a field name.")
              const type = value("type").trim() || "text"
              const rawOpts = value("options").split(",").map(s => s.trim()).filter(Boolean)
              return [
                ...currentFields,
                { name, type, ...(type === "select" && rawOpts.length ? { options: rawOpts } : {}) },
              ]
            }, { headers: cfHeaders, signal })
          } catch (err) {
            const status = (err as { status?: number })?.status
            if (typeof status === "number") {
              throw new BoardRequestError(
                err instanceof Error ? err.message : "Could not save Board custom fields.",
                status,
              )
            }
            throw err
          }
          break
        }
        case "send": {
          if (!content.title.trim()) throw new Error("Enter a task title.")
          const payload = { ...content, id: value("destination"), assignToRecipient: !recipient?.hidden && data.has("assign") }
          const signature = JSON.stringify(payload)
          if (submission && submission.content !== signature) {
            throw new Error("Retry the original submission or refresh Boards to review it before starting another.")
          }
          submission ??= { id: browserUuid(), content: signature }
          try {
            await jsonRequest("board-intake", "POST", { action: "prepare", ...payload, resumeId: submission.id })
          } catch (error) {
            if (error instanceof BoardRequestError && [400, 403, 404, 429].includes(error.status)) submission = undefined
            throw error
          }
          const result = await jsonRequest("board-intake", "POST", { action: "retry", resumeId: submission.id })
          submission = undefined
          form.reset()
          showAssignment()
          if (feedback) feedback.textContent = "Task sent. Receipt " + String(result.data?.acknowledgement)
          return
        }
        case "retry-send": {
          const result = await jsonRequest("board-intake", "POST", { action: "retry", resumeId: value("resumeId") })
          if (feedback) feedback.textContent = "Task sent. Receipt " + String(result.data?.acknowledgement)
          button.hidden = true
          return
        }
        default:
          return
      }
      if (!signal.aborted) leavePage()
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : "Could not save. Your input is still here."
        const unknownCreation = boardForm === "create" && (!(error instanceof BoardRequestError) || error.status >= 500)
        const displayMessage = unknownCreation
          ? "Could not confirm whether the Board was created. Refresh Boards to check before trying again."
          : message
        if (feedback) {
          feedback.textContent = displayMessage
          if (unknownCreation) button.hidden = true
        }
        if (boardForm === "custom-field-remove" || !feedback) {
          showToast(displayMessage, "error")
        }
      }
    } finally {
      form.removeAttribute("aria-busy")
      if (!navigating) button.classList.remove("btn-loading")
      if (!navigating && !form.dataset.boardPending) button.disabled = false
    }
  }, { signal })
}
