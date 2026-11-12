import type { FeedbackCursor, FeedbackReceipt, FeedbackReport } from "@domains/support/feedback-queue"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"

const endpoint = "/api/feedback"
const labels: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  declined: "Declined",
  problem: "Problem",
  accessibility: "Accessibility",
  suggestion: "Suggestion",
  other: "Other",
}

class FeedbackRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

function visible(element: HTMLElement): boolean {
  return element.isConnected && !element.closest("[hidden], [inert]") && element.getClientRects().length > 0
}

/** Completion owns only the control that initiated it, never a later user choice. */
function focusOwner(surface: HTMLElement, signal: AbortSignal, origin = document.activeElement as HTMLElement | null) {
  const scope = new AbortController()
  const lifetime = AbortSignal.any([signal, scope.signal])
  let owned = Boolean(origin && surface.contains(origin))
  let dialog: HTMLElement | null = null
  const belongs = (target: EventTarget | null) => target === origin || (target instanceof Node && Boolean(dialog?.contains(target)))
  document.addEventListener("focusin", event => { if (!belongs(event.target)) owned = false }, { signal: lifetime })
  document.addEventListener("pointerdown", event => { if (!belongs(event.target)) owned = false }, { signal: lifetime, capture: true })
  return {
    allowDialog(element: HTMLElement | null) { dialog = element },
    restore(target: HTMLElement | null) {
      const active = document.activeElement
      if (owned && !signal.aborted && visible(surface) && target && visible(target)
        && (active === origin || active === document.body || Boolean(dialog?.contains(active)))) target.focus()
    },
    dispose() { scope.abort() },
  }
}

async function requestFeedback<T>(path: string, signal: AbortSignal, method = "GET", body?: object): Promise<T> {
  const response = await fetch(path, {
    signal,
    method,
    cache: "no-store",
    headers: {
      ...(method === "GET" ? {} : { "x-meitheal-feedback": "1", "content-type": "application/json" }),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { detail?: string } | null
    throw new FeedbackRequestError(problem?.detail || "Could not reach local feedback. Check your Home Assistant connection.", response.status)
  }
  return response.status === 204 ? undefined as T : response.json()
}

function reportError(status: HTMLElement, error: unknown, signal: AbortSignal): void {
  if (signal.aborted) return
  status.textContent = error instanceof Error && error.name !== "TypeError"
    ? error.message
    : "Could not reach local feedback. Check your Home Assistant connection."
}

function submissionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()

  // Home Assistant also serves ingress on local HTTP, where only getRandomValues is available.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}

function initSubmission(panel: HTMLElement, signal: AbortSignal): void {
  const form = panel.querySelector<HTMLFormElement>("[data-feedback-form]")!
  const status = panel.querySelector<HTMLElement>("[data-feedback-status]")!
  const controls = form.querySelector("fieldset")!
  const message = form.elements.namedItem("message") as HTMLTextAreaElement
  let retry: { contents: string, submissionId: string } | null = null

  controls.disabled = false
  form.addEventListener("submit", async event => {
    event.preventDefault()
    if (controls.disabled) return
    const fields = new FormData(form)
    const text = message.value.trim()
    if (!text || new TextEncoder().encode(text).byteLength > 4096) {
      status.textContent = "Enter between 1 byte and 4 KiB of text."
      message.focus()
      return
    }

    const context = fields.get("context")
    const payload = {
      category: fields.get("category"),
      message: text,
      ...(typeof context === "string" ? { routeFamily: "settings", appVersion: context } : {}),
    }
    const contents = JSON.stringify(payload)
    if (retry?.contents !== contents) {
      retry = { contents, submissionId: submissionId() }
    }

    const focus = focusOwner(form, signal)
    controls.disabled = true
    status.textContent = "Saving feedback…"
    try {
      const receipt = await requestFeedback<FeedbackReceipt>(endpoint, signal, "POST", {
        ...payload, submissionId: retry.submissionId,
      })
      if (signal.aborted) return
      retry = null
      form.reset()
      status.textContent = `Feedback saved. Receipt ${receipt.id}.`
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof FeedbackRequestError && error.status === 403) panel.dispatchEvent(new Event("meitheal:feedback-denied"))
      reportError(status, error, signal)
    } finally {
      if (!signal.aborted) {
        controls.disabled = false
        focus.restore(message)
      }
      focus.dispose()
    }
  }, { signal })
}

function initQueue(panel: HTMLElement, queue: HTMLDetailsElement, signal: AbortSignal): void {
  const controls = queue.querySelector<HTMLFieldSetElement>("[data-queue-controls]")!
  const filter = queue.querySelector<HTMLSelectElement>("[data-feedback-filter]")!
  const refresh = queue.querySelector<HTMLButtonElement>("[data-feedback-refresh]")!
  const more = queue.querySelector<HTMLButtonElement>("[data-feedback-more]")!
  const list = queue.querySelector<HTMLElement>("[data-feedback-list]")!
  const status = queue.querySelector<HTMLElement>("[data-queue-status]")!
  const template = queue.querySelector<HTMLTemplateElement>("[data-feedback-report]")!
  let previews = new WeakMap<HTMLDetailsElement, string>()
  const drafts = new Map<string, { disposition: string, reviewedMessage: string }>()
  let denied = false
  let confirming = false
  let confirmation: AbortController | null = null
  const formatTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
  let cursor: FeedbackCursor | null = null
  let loaded = false
  controls.disabled = false

  function captureDrafts() {
    for (const entry of list.querySelectorAll<HTMLDetailsElement>("[data-report-id]")) {
      drafts.set(entry.dataset.reportId!, {
        disposition: entry.querySelector<HTMLTextAreaElement>('[name="disposition"]')!.value,
        reviewedMessage: entry.querySelector<HTMLTextAreaElement>('[name="reviewedMessage"]')!.value,
      })
    }
  }
  function invalidatePreviews() {
    previews = new WeakMap()
    for (const preview of list.querySelectorAll<HTMLElement>("[data-export-preview]")) {
      preview.hidden = true
      preview.textContent = ""
    }
    for (const download of list.querySelectorAll<HTMLElement>("[data-download-export]")) download.hidden = true
  }
  function denyAccess() {
    denied = true
    confirmation?.abort()
    drafts.clear()
    invalidatePreviews()
    list.replaceChildren()
    cursor = null
    more.hidden = true
    controls.disabled = true
    status.textContent = "Your current Home Assistant access no longer permits this queue. Reopen Settings after checking your access."
  }
  panel.addEventListener("meitheal:feedback-denied", denyAccess, { signal })
  signal.addEventListener("abort", () => { drafts.clear(); confirmation?.abort(); observer.disconnect() }, { once: true })
  const checkVisibility = () => { if (!visible(panel) || !queue.open) confirmation?.abort() }
  const observer = new MutationObserver(checkVisibility)
  for (let ancestor: HTMLElement | null = panel; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ["hidden", "style", "class", "inert"] })
  }
  window.addEventListener("hashchange", checkVisibility, { signal })
  queue.addEventListener("toggle", checkVisibility, { signal })

  function renderReport(report: FeedbackReport): HTMLDetailsElement {
    const existing = [...list.querySelectorAll<HTMLDetailsElement>("[data-report-id]")].find(entry => entry.dataset.reportId === report.id)
    const entry = existing ?? template.content.firstElementChild!.cloneNode(true) as HTMLDetailsElement
    entry.dataset.reportId = report.id
    entry.querySelector("[data-report-summary]")!.textContent =
      `${labels[report.category]} · ${labels[report.state]} · ${formatTime.format(report.receivedAt)}`
    entry.querySelector("[data-report-message]")!.textContent = report.message
    entry.querySelector("[data-report-context]")!.textContent = [
      `Submitted by ${report.submitterId}`,
      report.appVersion && `Version ${report.appVersion}`,
      report.routeFamily && `Page category ${report.routeFamily}`,
      report.claimedBy && `Claimed by ${report.claimedBy}`,
      report.closedBy && `Closed by ${report.closedBy}`,
    ].filter(Boolean).join(" · ")
    const disposition = entry.querySelector<HTMLElement>("[data-report-disposition]")!
    disposition.hidden = !report.disposition
    disposition.textContent = report.disposition ? `Disposition: ${report.disposition}` : ""
    entry.querySelector<HTMLElement>("[data-claim-report]")!.hidden = report.state !== "open"
    entry.querySelector<HTMLElement>("[data-close-report]")!.hidden = report.state !== "in_progress"
    entry.querySelector<HTMLElement>("[data-delete-report]")!.hidden =
      report.state !== "resolved" && report.state !== "declined"
    const draft = drafts.get(report.id)
    if (draft) {
      entry.querySelector<HTMLTextAreaElement>('[name="disposition"]')!.value = draft.disposition
      entry.querySelector<HTMLTextAreaElement>('[name="reviewedMessage"]')!.value = draft.reviewedMessage
    }
    return entry
  }

  async function run(pending: string, operation: () => Promise<void>): Promise<void> {
    if (controls.disabled || confirming || denied || signal.aborted) return
    captureDrafts()
    controls.disabled = true
    status.textContent = pending
    try {
      await operation()
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof FeedbackRequestError && error.status === 403) denyAccess()
      else reportError(status, error, signal)
    } finally {
      if (!signal.aborted) controls.disabled = denied
    }
  }

  function load(append = false): void {
    const focus = focusOwner(queue, signal)
    void run("Loading reports…", async () => {
      invalidatePreviews()
      const query = new URLSearchParams()
      if (filter.value) query.set("state", filter.value)
      if (append && cursor) {
        query.set("before", String(cursor.receivedAt))
        query.set("beforeId", cursor.id)
      }
      const page = await requestFeedback<{ reports: FeedbackReport[], nextCursor: FeedbackCursor | null }>(
        `${endpoint}?${query}`, signal,
      )
      if (signal.aborted || denied) return
      const entries = page.reports.map(renderReport)
      if (append) list.append(...entries)
      else {
        for (const [index, entry] of entries.entries()) {
          if (list.children[index] !== entry) list.insertBefore(entry, list.children[index] ?? null)
        }
        for (const entry of [...list.children]) if (!entries.includes(entry as HTMLDetailsElement)) entry.remove()
      }
      cursor = page.nextCursor
      more.hidden = !cursor
      loaded = true
      status.textContent = list.children.length
        ? `${list.children.length} ${list.children.length === 1 ? "report" : "reports"} shown.`
        : "No reports match this state."
      if (append) focus.restore(entries[0]?.querySelector("summary") ?? null)
    }).finally(() => focus.dispose())
  }

  async function changeReport(entry: HTMLDetailsElement, state: string, disposition?: FormDataEntryValue | null) {
    const focus = focusOwner(queue, signal)
    await run("Saving review…", async () => {
      invalidatePreviews()
      const report = await requestFeedback<FeedbackReport>(`${endpoint}/${entry.dataset.reportId}`, signal, "PATCH", {
        state, ...(disposition !== undefined ? { disposition } : {}),
      })
      if (signal.aborted || denied) return
      const updated = renderReport(report)
      if (!filter.value || filter.value === report.state) {
        updated.open = true
        focus.restore(updated.querySelector("summary"))
      } else {
        entry.remove()
      }
      status.textContent = `Report marked ${labels[report.state]?.toLowerCase()}.`
    })
    focus.restore(entry.isConnected ? null : refresh)
    focus.dispose()
  }

  queue.addEventListener("toggle", () => {
    if (queue.open && !loaded) load()
  }, { signal })
  filter.addEventListener("change", () => {
    cursor = null
    more.hidden = true
    load()
  }, { signal })
  refresh.addEventListener("click", () => load(), { signal })
  more.addEventListener("click", () => load(true), { signal })

  list.addEventListener("click", async event => {
    if (controls.disabled || confirming || denied || signal.aborted) return
    const button = (event.target as HTMLElement).closest("button")
    const entry = button?.closest<HTMLDetailsElement>("[data-report-id]")
    if (!button || !entry) return

    if (button.hasAttribute("data-claim-report")) {
      await changeReport(entry, "in_progress")
    }
    if (button.hasAttribute("data-delete-report")) {
      confirming = true
      confirmation = new AbortController()
      const local = confirmation
      const dialogSignal = AbortSignal.any([signal, local.signal])
      // Construct before tracking focus so the dialog's initial Cancel focus is expected.
      const previousFocus = document.activeElement as HTMLElement | null
      const pending = confirmDialog({
        title: "Delete this closed report?",
        message: "This removes the local report and its receipt permanently.",
        confirmText: "Delete report", variant: "danger", signal: dialogSignal,
      })
      const focus = focusOwner(queue, signal, previousFocus)
      focus.allowDialog(document.getElementById("meitheal-confirm-overlay"))
      const confirmed = await pending
      const cancelled = dialogSignal.aborted
      // Remove the helper's trap now and suppress its delayed unconditional focus return.
      local.abort()
      confirmation = null
      confirming = false
      if (!confirmed || cancelled || signal.aborted || denied || !visible(panel)) {
        if (!cancelled) focus.restore(previousFocus)
        focus.dispose()
        return
      }
      await run("Deleting report…", async () => {
        await requestFeedback(`${endpoint}/${entry.dataset.reportId}`, signal, "DELETE")
        if (signal.aborted || denied) return
        drafts.delete(entry.dataset.reportId!)
        previews.delete(entry)
        entry.remove()
        status.textContent = "Report deleted."
      })
      focus.restore(entry.isConnected ? previousFocus : refresh)
      focus.dispose()
    }
    if (button.hasAttribute("data-download-export")) {
      const reviewed = previews.get(entry)
      if (!reviewed) return
      const url = URL.createObjectURL(new Blob([reviewed], { type: "application/json" }))
      const download = document.createElement("a")
      download.href = url
      download.download = "meitheal-feedback.json"
      download.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      status.textContent = "Reviewed export is ready in your downloads."
    }
  }, { signal })

  list.addEventListener("submit", async event => {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    const entry = form.closest<HTMLDetailsElement>("[data-report-id]")
    if (!entry) return
    const fields = new FormData(form)

    if (form.hasAttribute("data-close-report")) {
      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null
      if (submitter) await changeReport(entry, submitter.value, fields.get("disposition"))
    }
    if (form.hasAttribute("data-review-export")) {
      await run("Preparing preview…", async () => {
        const reviewed = await requestFeedback<unknown>(`${endpoint}/${entry.dataset.reportId}/export`, signal, "POST", {
          reviewedMessage: fields.get("reviewedMessage"),
        })
        if (signal.aborted || denied || !entry.isConnected) return
        const json = JSON.stringify(reviewed, null, 2)
        previews.set(entry, json)
        const preview = form.querySelector<HTMLElement>("[data-export-preview]")!
        preview.textContent = json
        preview.hidden = false
        form.querySelector<HTMLButtonElement>("[data-download-export]")!.hidden = false
        status.textContent = "Review the preview before downloading."
      })
    }
  }, { signal })

  list.addEventListener("input", event => {
    captureDrafts()
    const input = event.target as HTMLTextAreaElement
    const form = input.closest<HTMLFormElement>("[data-review-export]")
    const entry = form?.closest<HTMLDetailsElement>("[data-report-id]")
    if (!form || !entry) return
    previews.delete(entry)
    const preview = form.querySelector<HTMLElement>("[data-export-preview]")!
    preview.hidden = true
    preview.textContent = ""
    form.querySelector<HTMLButtonElement>("[data-download-export]")!.hidden = true
  }, { signal })
}

export function initSettingsFeedback(): void {
  const panel = document.querySelector<HTMLElement>("[data-feedback-panel]")
  if (!panel) return
  const registry = window as Window & { __meithealFeedbackScope?: AbortController }
  registry.__meithealFeedbackScope?.abort()
  const scope = new AbortController()
  registry.__meithealFeedbackScope = scope
  const signal = AbortSignal.any([pageLifecycle.signal, scope.signal])
  initSubmission(panel, signal)
  const queue = panel.querySelector<HTMLDetailsElement>("[data-feedback-queue]")
  if (queue) initQueue(panel, queue, signal)
}
