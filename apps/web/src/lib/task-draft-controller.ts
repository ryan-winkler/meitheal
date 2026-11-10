import {
  activateDraftUpdate, DraftAccessError, draftLeaseDuration, draftRenewAfter, privateIngressScope,
  readDraft, verifyDraftLease, writeDraft, type DraftLease,
} from "./task-draft-client"
import { taskDraftText } from "./task-draft-copy"
import type {
  SavedTaskDraft, TaskDraftPublication, TaskDraftRead, TaskDraftReceipt, TaskDraftSnapshot, TaskDraftVersion, TaskDraftWrite,
} from "./task-draft-state"

type Publication = Extract<TaskDraftWrite, { action: "publish" }>
type Selector = NonNullable<TaskDraftRead["resolve"]>
type Marker = { selector: Selector; expiresAt: number }

const markerKey = "meitheal-draft-operation"
const markerDuration = 300_000

function readMarker(): Marker | undefined {
  try {
    const marker = JSON.parse(sessionStorage.getItem(markerKey) ?? "null") as Marker | null
    if (marker && marker.expiresAt > Date.now() && marker.expiresAt <= Date.now() + markerDuration &&
        /^[a-f0-9-]{36}$/.test(marker.selector.attemptId) &&
        (marker.selector.kind === "save" ||
          marker.selector.kind === "publish" && /^[a-f0-9-]{36}$/.test(marker.selector.draftId)
            && Number.isSafeInteger(marker.selector.revision) && marker.selector.revision > 0)) return marker
    sessionStorage.removeItem(markerKey)
  } catch { /* Private storage can be unavailable. */ }
  return undefined
}

function version(draft: TaskDraftVersion): TaskDraftVersion {
  return { draftId: draft.draftId, revision: draft.revision }
}

interface DraftEditor {
  snapshot(): TaskDraftSnapshot
  restore(snapshot: TaskDraftSnapshot): void
  clear(): void
  selectedFiles(): boolean
  ordinarySubmitting(): boolean
  stateChanged(bound: boolean, disabled: boolean, withdrawn: boolean): void
  taskPublished(receipt: TaskDraftReceipt): void
  openTask(receipt: TaskDraftReceipt): void
  focusTitle(): void
}

export function connectTaskDrafts(overlay: HTMLElement, editor: DraftEditor, signal: AbortSignal) {
  const button = (id: string) => overlay.querySelector<HTMLButtonElement>("#nt-draft-" + id)!
  const toggle = button("toggle")
  const panel = overlay.querySelector<HTMLElement>("#nt-draft-panel")!
  const status = overlay.querySelector<HTMLElement>("#nt-draft-status")!
  const confirmPanel = overlay.querySelector<HTMLElement>("#nt-draft-confirm")!
  const confirmMessage = overlay.querySelector<HTMLElement>("#nt-draft-confirm-message")!
  const save = button("save")
  const resume = button("resume")
  const discard = button("discard")
  const recover = button("recover")
  const retry = button("retry")
  const abandon = button("abandon")
  const clear = button("clear")
  const update = button("update")
  const openTask = button("open-task")
  const confirm = button("confirm-yes")
  const cancel = button("confirm-no")

  let opened = false
  let expanded = false
  let lease: DraftLease | undefined
  let available: SavedTaskDraft | null = null
  let bound: TaskDraftVersion | undefined
  let receipt: TaskDraftReceipt | null = null
  let locked = false
  let withdrawn = false
  let dirty = false
  let edit = 0
  let marker: Marker | undefined
  let frozen: Publication | undefined
  let suspended: { snapshot: TaskDraftSnapshot; expiresAt: number } | undefined
  let operation: AbortController | undefined
  let notice = ""
  let updateNeeded = false
  let canAbandon = false
  let timer: number | undefined
  let expiration: number | undefined
  let confirmation: { trigger: HTMLButtonElement; run: () => void } | undefined

  function setMarker(selector?: Selector) {
    marker = selector ? { selector, expiresAt: Date.now() + markerDuration } : undefined
    try {
      if (marker) sessionStorage.setItem(markerKey, JSON.stringify(marker))
      else sessionStorage.removeItem(markerKey)
    } catch { /* Continue within the current page. */ }
  }

  function foreground() {
    return opened && document.visibilityState !== "hidden" && document.hasFocus() && navigator.onLine
  }

  function canSubmit() {
    return !operation && !locked && (!bound || Boolean(lease && foreground()
      && performance.now() < lease.verifiedAt + draftLeaseDuration && !withdrawn))
  }

  function render() {
    toggle.hidden = !privateIngressScope()
    toggle.setAttribute("aria-expanded", String(expanded))
    panel.hidden = !expanded
    status.textContent = notice
    const pending = Boolean(operation) || editor.ordinarySubmitting()
    const awaiting = Boolean(marker)
    const verified = Boolean(lease)
    const editable = verified && !withdrawn
    save.hidden = !editable || awaiting || locked
    save.textContent = !bound && available ? taskDraftText("replace") : taskDraftText("save")
    resume.hidden = !available || !verified || awaiting || Boolean(bound && !locked)
    resume.textContent = locked ? taskDraftText("reload") : taskDraftText("resume")
    discard.hidden = (!available && !bound) || !editable || awaiting || locked
    recover.hidden = !awaiting && verified && !locked
    recover.textContent = awaiting ? taskDraftText("check_status") : taskDraftText("check")
    retry.hidden = !canAbandon || !frozen || !verified
    abandon.hidden = !canAbandon || !verified
    clear.hidden = !locked || canAbandon
    update.hidden = !updateNeeded
    openTask.hidden = !receipt || !verified || !receipt.ticketKey
    for (const action of [save, resume, discard, recover, retry, abandon, clear, update, openTask]) action.disabled = pending
    editor.stateChanged(Boolean(bound), !canSubmit() || editor.ordinarySubmitting(), withdrawn)
  }

  function stopTimers() {
    window.clearTimeout(timer)
    window.clearTimeout(expiration)
  }

  function dismissConfirmation(restoreFocus = true) {
    if (!confirmation) return false
    const { trigger } = confirmation
    confirmation = undefined
    confirmPanel.hidden = true
    if (restoreFocus) trigger.focus()
    return true
  }

  function ask(trigger: HTMLButtonElement, message: string, run: () => void) {
    confirmation = { trigger, run }
    confirmMessage.textContent = message
    confirmPanel.hidden = false
    cancel.focus()
  }

  function withdraw(permanent: boolean, message: string) {
    operation?.abort()
    operation = undefined
    stopTimers()
    dismissConfirmation(false)
    if (bound && !withdrawn) {
      if (!permanent && lease) suspended = { snapshot: editor.snapshot(), expiresAt: lease.verifiedAt + draftLeaseDuration }
      editor.clear()
      withdrawn = true
    }
    available = receipt = null
    canAbandon = false
    if (permanent || (!bound && !marker)) {
      suspended = frozen = undefined
      lease = undefined
      locked = Boolean(bound || marker)
    } else if (lease) {
      expiration = window.setTimeout(() => withdraw(true, taskDraftText("verify_again")), Math.max(0,
        lease.verifiedAt + draftLeaseDuration - performance.now()))
    }
    if (bound || marker || expanded) notice = message
    render()
  }

  function arm(current: DraftLease) {
    stopTimers()
    lease = current
    expiration = window.setTimeout(() => withdraw(true, taskDraftText("verify_again")), Math.max(0,
      current.verifiedAt + draftLeaseDuration - performance.now()))
    timer = window.setTimeout(() => {
      if (foreground() && !operation) void renew(current)
    }, Math.max(0, current.verifiedAt + draftRenewAfter - performance.now()))
  }

  async function renew(current: DraftLease) {
    const local = new AbortController()
    operation = local
    try {
      const next = await verifyDraftLease(current, AbortSignal.any([signal, local.signal]))
      if (operation !== local || !foreground()) return
      if (suspended && performance.now() < suspended.expiresAt) editor.restore(suspended.snapshot)
      suspended = undefined
      withdrawn = false
      notice = bound ? taskDraftText("ready") : ""
      arm(next)
    } catch (error) {
      if (operation === local) handleError(error)
    } finally {
      if (operation === local) operation = undefined
      render()
    }
  }

  function handleError(error: unknown) {
    const kind = error instanceof DraftAccessError ? error.kind : "network"
    if (kind === "account" || kind === "update") {
      updateNeeded = kind === "update"
      withdraw(true, kind === "account" ? taskDraftText("session_changed")
        : taskDraftText("update_first"))
    } else if (kind === "conflict") {
      setMarker()
      frozen = undefined
      canAbandon = false
      locked = true
      notice = taskDraftText("conflict")
    } else if (kind === "invalid") {
      setMarker()
      frozen = undefined
      canAbandon = false
      locked = false
      notice = taskDraftText("invalid")
    } else {
      if (marker) locked = true
      notice = kind === "busy" ? taskDraftText("busy")
        : taskDraftText("unconfirmed")
    }
  }

  function applyDraft(draft: SavedTaskDraft, focus = true) {
    bound = version(draft)
    available = draft
    withdrawn = false
    locked = false
    editor.restore(draft.snapshot)
    dirty = false
    if (focus) { render(); editor.focusTitle() }
  }

  function finishPublished(value: TaskDraftReceipt) {
    operation = undefined
    setMarker()
    frozen = undefined
    bound = undefined
    available = null
    receipt = value
    locked = withdrawn = canAbandon = false
    dirty = false
    editor.clear()
    notice = value.ticketKey ? taskDraftText("published").replace("{ticket}", value.ticketKey) : taskDraftText("removed")
    render()
    editor.taskPublished(value)
    if (value.ticketKey) openTask.focus()
  }

  async function load(resumeAfter = false) {
    if (!foreground() || operation || editor.ordinarySubmitting()) return
    expanded = true
    const local = new AbortController()
    const startedEdit = edit
    operation = local
    notice = taskDraftText("checking")
    render()
    try {
      const current = lease
      const data = await readDraft({ action: "read", ...(marker ? { resolve: marker.selector } : {}) },
        AbortSignal.any([signal, local.signal]), current)
      if (operation !== local || !foreground()) return
      arm(data.lease)
      available = data.data.draft ?? null
      receipt = data.data.latestReceipt ?? null
      const result = data.data.resolution
      canAbandon = result?.state === "open"
      updateNeeded = false

      if (result?.state === "published") {
        finishPublished(result.receipt)
      } else if (result?.state === "saved" && available && edit === startedEdit) {
        setMarker()
        applyDraft(available)
        notice = taskDraftText("saved")
      } else if (marker && canAbandon) {
        locked = true
        notice = taskDraftText("unresolved")
      } else if (marker) {
        setMarker()
        frozen = undefined
        locked = Boolean(bound)
        notice = taskDraftText("attempt_unavailable")
      } else if (resumeAfter && available && edit === startedEdit) {
        applyDraft(available)
        notice = taskDraftText("ready_edit")
      } else if (bound && withdrawn) {
        notice = taskDraftText("reload_or_new")
        locked = true
      } else {
        notice = available ? taskDraftText("available") : taskDraftText("none")
      }
    } catch (error) {
      if (operation === local) handleError(error)
    } finally {
      if (operation === local) operation = undefined
      render()
    }
  }

  async function write(action: TaskDraftWrite) {
    if (!lease || !foreground() || operation || editor.ordinarySubmitting()) return
    const local = new AbortController()
    const active = AbortSignal.any([signal, local.signal])
    const startedEdit = edit
    operation = local
    notice = action.action === "publish" ? taskDraftText("publishing") : taskDraftText("saving")
    render()
    try {
      const next = await verifyDraftLease(lease, active)
      if (operation !== local || !foreground()) return
      arm(next)
      const reply = await writeDraft(action, next, active)
      if (operation !== local || !foreground()) return
      arm(reply.lease)
      updateNeeded = false
      if (reply.data.receipt) {
        finishPublished(reply.data.receipt)
      } else if (reply.data.draft) {
        setMarker()
        frozen = undefined
        canAbandon = false
        if (action.action === "save" && edit !== startedEdit) {
          bound = version(reply.data.draft)
          available = reply.data.draft
          locked = withdrawn = false
          notice = taskDraftText("saved_new_edits")
        } else {
          applyDraft(reply.data.draft, action.action === "abandon-publish")
          notice = action.action === "save" ? taskDraftText("saved") : taskDraftText("kept")
        }
      } else if (action.action === "discard" && reply.data.draft === null) {
        setMarker()
        bound = undefined
        available = null
        locked = withdrawn = false
        editor.clear()
        dirty = false
        editor.focusTitle()
        notice = taskDraftText("discarded")
      } else {
        throw new DraftAccessError("network")
      }
    } catch (error) {
      if (operation === local) handleError(error)
    } finally {
      if (operation === local) operation = undefined
      render()
    }
  }

  function saveCurrent() {
    if (!lease || !foreground() || operation || editor.ordinarySubmitting()) return
    if (editor.selectedFiles()) {
      notice = taskDraftText("file_save")
      render()
      return
    }
    const expected = bound ?? (available ? version(available) : null)
    const attemptId = crypto.randomUUID()
    setMarker({ kind: "save", attemptId })
    void write({ action: "save", expected, attemptId, snapshot: editor.snapshot() })
  }

  toggle.addEventListener("click", () => {
    expanded = !expanded
    render()
    if (expanded && (!lease || marker)) void load()
  }, { signal })
  save.addEventListener("click", () => {
    if (!bound && available) ask(save, taskDraftText("confirm_replace"), saveCurrent)
    else saveCurrent()
  }, { signal })
  resume.addEventListener("click", () => {
    const proceed = () => { void load(true) }
    if (dirty) ask(resume, taskDraftText("confirm_resume"), proceed)
    else proceed()
  }, { signal })
  discard.addEventListener("click", () => {
    const target = bound ?? available
    if (target) {
      const expected = version(target)
      ask(discard, taskDraftText("confirm_discard"), () => { void write({ action: "discard", expected }) })
    }
  }, { signal })
  recover.addEventListener("click", () => { void load() }, { signal })
  retry.addEventListener("click", () => { if (frozen) void write(frozen) }, { signal })
  abandon.addEventListener("click", () => {
    const selector = marker?.selector
    if (selector?.kind === "publish") {
      ask(abandon, taskDraftText("confirm_keep"), () => {
        void write({ action: "abandon-publish", expected: version(selector), attemptId: selector.attemptId })
      })
    }
  }, { signal })
  clear.addEventListener("click", () => {
    setMarker()
    bound = undefined
    frozen = undefined
    locked = withdrawn = dirty = false
    editor.clear()
    notice = taskDraftText("ready_new")
    render()
    editor.focusTitle()
  }, { signal })
  update.addEventListener("click", async () => {
    const activated = await activateDraftUpdate(signal).catch(() => false)
    if (!opened) return
    notice = activated ? taskDraftText("activating") : taskDraftText("update_wait")
    render()
  }, { signal })
  openTask.addEventListener("click", () => { if (receipt?.ticketKey && lease && foreground()) editor.openTask(receipt) }, { signal })
  confirm.addEventListener("click", () => {
    const run = confirmation?.run
    dismissConfirmation()
    run?.()
  }, { signal })
  cancel.addEventListener("click", () => { dismissConfirmation() }, { signal })

  function resumeForeground() {
    if (foreground() && !operation && lease && withdrawn && performance.now() < lease.verifiedAt + draftLeaseDuration) {
      void renew(lease)
    }
  }
  window.addEventListener("blur", () => { if (opened && (bound || marker || lease)) withdraw(false, taskDraftText("paused_inactive")) }, { signal })
  window.addEventListener("focus", resumeForeground, { signal })
  window.addEventListener("offline", () => { if (opened) withdraw(false, taskDraftText("reconnect")) }, { signal })
  window.addEventListener("online", resumeForeground, { signal })
  document.addEventListener("visibilitychange", () => {
    if (!opened) return
    if (document.visibilityState === "hidden") withdraw(false, taskDraftText("paused_hidden"))
    else resumeForeground()
  }, { signal })
  window.addEventListener("pagehide", () => { if (opened) withdraw(true, taskDraftText("verify_again")) }, { signal })
  window.addEventListener("pageshow", event => {
    if (event.persisted && opened && expanded && foreground() && !operation) void load()
  }, { signal })
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    updateNeeded = false
    if (opened) withdraw(true, taskDraftText("updated"))
  }, { signal })

  function close() {
    opened = expanded = false
    withdraw(true, "")
    bound = undefined
    marker = undefined
    locked = withdrawn = dirty = canAbandon = updateNeeded = false
    render()
  }
  signal.addEventListener("abort", close, { once: true })

  render()
  return {
    open() {
      opened = true
      notice = ""
      edit = 0
      dirty = false
      marker = readMarker()
      locked = expanded = Boolean(marker)
      render()
      if (marker) void load()
    },
    close,
    edited() { edit++; dirty = true },
    dismissConfirmation,
    isBound: () => Boolean(bound),
    canSubmit,
    render,
    publish(task: TaskDraftPublication) {
      expanded = true
      if (!bound || !lease || !canSubmit()) return
      const expected = bound
      const attemptId = crypto.randomUUID()
      setMarker({ kind: "publish", ...expected, attemptId })
      frozen = { action: "publish", expected, attemptId, task }
      void write(frozen)
    },
  }
}
