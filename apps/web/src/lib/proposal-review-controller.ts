import { pageLifecycle } from "@lib/page-lifecycle"

type Decision = "accept" | "reject"
type ReviewState = "ready" | "pending" | "blocked" | "done"

interface Binding {
  root: HTMLElement
  pageSignal: AbortSignal
  controller: AbortController
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

pageLifecycle.onPageLoad(pageSignal => {
  const root = document.getElementById("review-queue")
  if (!root) return
  const runtime = window as unknown as { __meithealProposalReview?: Binding }
  const previous = runtime.__meithealProposalReview
  if (previous?.root === root && previous.pageSignal === pageSignal && !previous.controller.signal.aborted) return
  previous?.controller.abort()
  const controller = new AbortController()
  runtime.__meithealProposalReview = { root, pageSignal, controller }
  const signal = AbortSignal.any([pageSignal, controller.signal])
  const authorityStatus = document.getElementById("review-authority-status")
  let authorityDenied = false
  const updateCards: Array<() => void> = []

  root.querySelectorAll<HTMLElement>("[data-proposal-review]").forEach(card => {
    const form = card.querySelector<HTMLFormElement>("[data-review-decision]")
    const status = card.querySelector<HTMLElement>("[data-review-status]")
    const buttons = [...card.querySelectorAll<HTMLButtonElement>("button[name=action]")]
    if (!form || !status) return
    // These values identify the snapshot actually rendered to the reviewer.
    // Do not replace the hash from another fetch before submitting a decision.
    const id = card.dataset.taskId ?? ""
    const displayedHash = card.dataset.proposalHash ?? ""
    const expiresAt = Number(card.dataset.expiresAt)
    const stale = card.dataset.stale === "true"
    let state: ReviewState = "ready"

    const expired = () => !Number.isFinite(expiresAt) || expiresAt <= Date.now()
    function update() {
      if (state === "ready" && expired()) {
        state = "blocked"
        status!.textContent = "This proposal expired. Refresh the queue to see what is still pending."
      }
      if (!id || !/^[a-f0-9]{64}$/.test(displayedHash)) {
        state = "blocked"
        status!.textContent = "This proposal cannot be verified. Refresh before reviewing it."
      }
      card.dataset.reviewState = state
      card.setAttribute("aria-busy", String(state === "pending"))
      for (const button of buttons) {
        // aria-disabled preserves keyboard focus while the request is pending.
        button.disabled = false
        button.setAttribute("aria-disabled", String(authorityDenied || state !== "ready" || (stale && button.value === "accept")))
      }
    }
    updateCards.push(update)
    update()

    form.addEventListener("submit", async event => {
      event.preventDefault()
      const button = event.submitter
      const action = button instanceof HTMLButtonElement ? button.value : ""
      update()
      if (signal.aborted || authorityDenied || state !== "ready" || (action !== "accept" && action !== "reject") || (stale && action === "accept")) return
      state = "pending"
      status.textContent = action === "accept" ? "Accepting the displayed proposal…" : "Rejecting the displayed proposal…"
      update()
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/accept-proposal`, {
          method: "POST", cache: "no-store", signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: action as Decision, proposal_hash: displayedHash }),
        })
        const receipt: unknown = await response.json().catch(() => null)
        if (signal.aborted) return
        if (response.ok && record(receipt) && receipt.ok === true && receipt.id === id && receipt.action === action) {
          state = "done"
          status.textContent = action === "accept" ? "Proposal accepted. The task was updated." : "Proposal rejected. The task was not changed."
          status.focus({ preventScroll: true })
        } else {
          state = "blocked"
          const detail = record(receipt) && typeof receipt.detail === "string" ? receipt.detail : "The decision was not confirmed."
          status.textContent = `${detail} Refresh the queue before deciding again.`
          if (response.status === 403) {
            authorityDenied = true
            if (authorityStatus) authorityStatus.textContent = "Administrator access was not confirmed. Decisions are unavailable. Refresh through Home Assistant with a current administrator account."
          }
        }
      } catch {
        if (signal.aborted) return
        state = "blocked"
        status.textContent = "No confirmation was received. The decision may have been saved. Refresh the queue and check the task before trying again."
      } finally {
        if (!signal.aborted) for (const updateCard of updateCards) updateCard()
      }
    }, { signal })
  })

  const interval = window.setInterval(() => {
    for (const update of updateCards) update()
  }, 1000)
  signal.addEventListener("abort", () => clearInterval(interval), { once: true })
})
