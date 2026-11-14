import { isActiveParticipantProblem } from "@lib/task-participant-problem"

interface Reaction {
  id: number
  content: string
  author: string
  can_manage: boolean
}

interface ReactionPage {
  reactions: Reaction[]
  next_cursor: string | null
  can_react: boolean
}

export function mountReactions(host: HTMLElement, url: string, signal: AbortSignal, taskId?: string): void {
  const template = document.querySelector<HTMLTemplateElement>("#td-reaction-controls")
  if (!template || signal.aborted) return

  const panel = document.createElement("details")
  panel.className = "mt-2 rounded-md border border-border px-3"
  panel.dataset.reactionPanel = taskId === undefined ? "comment" : "task"
  const summary = document.createElement("summary")
  summary.className = "min-h-11 cursor-pointer py-3 text-sm font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
  summary.textContent = (taskId === undefined ? template.dataset.commentLabel : template.dataset.taskLabel) ?? ""
  panel.append(summary)
  host.append(panel)

  const openPanel = () => {
    if (!panel.open || !panel.isConnected) return
    panel.removeEventListener("toggle", openPanel)
    initReactionPanel(panel, summary, template, url, signal, taskId)
  }
  panel.addEventListener("toggle", openPanel, { signal })
}

function initReactionPanel(
  panel: HTMLDetailsElement, summary: HTMLElement, template: HTMLTemplateElement,
  url: string, signal: AbortSignal, taskId?: string,
): void {
  panel.append(template.content.cloneNode(true))
  const labels = template.dataset
  const status = panel.querySelector<HTMLElement>("[data-reaction-status]")!
  const error = panel.querySelector<HTMLElement>("[data-reaction-error]")!
  const list = panel.querySelector<HTMLUListElement>("[data-reaction-list]")!
  const retry = panel.querySelector<HTMLButtonElement>("[data-reaction-retry]")!
  const newest = panel.querySelector<HTMLButtonElement>("[data-reaction-newest]")!
  const older = panel.querySelector<HTMLButtonElement>("[data-reaction-older]")!
  const form = panel.querySelector<HTMLFormElement>("[data-reaction-form]")!
  const input = form.querySelector<HTMLInputElement>("input")!
  let busy = false
  let pageCursor: string | null = null
  let retryCursor: string | null = null
  let nextCursor: string | null = null

  const isCurrent = () => !signal.aborted && panel.isConnected

  function setBusy(value: boolean): void {
    busy = value
    list.setAttribute("aria-busy", String(value))
    input.readOnly = value
  }

  function render(reaction: Reaction): HTMLLIElement {
    const row = document.createElement("li")
    row.className = "flex min-h-11 flex-wrap items-center gap-x-2 rounded-md bg-bg-input px-2 text-sm wrap-anywhere"
    const content = document.createElement("bdi")
    content.className = "font-medium text-text-primary"
    content.textContent = reaction.content
    const author = document.createElement("bdi")
    author.className = "text-text-secondary"
    author.textContent = reaction.author
    row.append(content, author)
    if (reaction.can_manage) {
      const remove = document.createElement("button")
      remove.type = "button"
      remove.className = "btn btn-ghost ms-auto min-h-11"
      remove.dataset.reactionRemove = String(reaction.id)
      remove.textContent = labels.remove ?? ""
      remove.setAttribute("aria-label", labels.removeDescription?.replace("{reaction}", () => reaction.content) ?? "")
      row.append(remove)
    }
    return row
  }

  async function load(cursor: string | null, notice?: string): Promise<void> {
    if (busy || !isCurrent()) return
    const active = document.activeElement
    const focusMayDisappear = active === retry || active === newest || active === older || list.contains(active)
    setBusy(true)
    retryCursor = cursor
    retry.hidden = true
    error.textContent = ""
    status.textContent = labels.loading ?? ""
    try {
      const response = await fetch(cursor ? `${url}?cursor=${encodeURIComponent(cursor)}` : url, { // nosemgrep
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        cache: "no-store",
      })
      if (!isCurrent()) return
      if (response.status === 401 || response.status === 403) {
        const participantDenied = await isActiveParticipantProblem(response)
        if (!isCurrent()) return
        list.replaceChildren()
        form.hidden = newest.hidden = older.hidden = true
        status.textContent = (participantDenied ? labels.participantRequired : labels.unavailable) ?? ""
        return
      }
      if (!response.ok) throw new Error("Reaction list unavailable")
      const data: ReactionPage = await response.json()
      if (!isCurrent()) return
      list.replaceChildren(...data.reactions.map(render))
      pageCursor = cursor
      nextCursor = data.next_cursor
      form.hidden = !data.can_react
      newest.hidden = cursor === null
      older.hidden = !nextCursor
      status.textContent = notice ?? (data.reactions.length ? "" : labels.empty ?? "")
    } catch {
      if (!isCurrent()) return
      status.textContent = notice ?? ""
      error.textContent = labels.loadFailed ?? ""
      retry.hidden = false
    } finally {
      if (isCurrent()) {
        setBusy(false)
        if (panel.open && focusMayDisappear && document.activeElement === document.body) {
          const target = !retry.hidden ? retry : !older.hidden ? older : !newest.hidden ? newest : summary
          target.focus()
        }
      }
    }
  }

  async function mutate(remove?: HTMLButtonElement): Promise<void> {
    if (busy || !isCurrent()) return
    const content = input.value.trim().normalize("NFC")
    const length = [...content].length
    error.textContent = ""
    if (!remove && (length === 0 || length > 16)) {
      error.textContent = labels.invalid ?? ""
      input.focus()
      return
    }
    let saved = false
    setBusy(true)
    status.textContent = labels.saving ?? ""
    try {
      const response = await fetch(remove ? `${url}/${remove.dataset.reactionRemove}` : url, {
        method: remove ? "DELETE" : "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ...(remove ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }),
      })
      const participantDenied = await isActiveParticipantProblem(response)
      if (!isCurrent()) return
      saved = response.ok
      if (participantDenied) error.textContent = labels.participantRequired ?? ""
      else if (!remove && response.status === 400) error.textContent = labels.invalid ?? ""
    } catch {
      // Keep the draft and the current page available for retry.
    } finally {
      if (isCurrent()) {
        setBusy(false)
        status.textContent = ""
      }
    }
    if (!isCurrent()) return
    if (!remove && panel.open && form.contains(document.activeElement)) input.focus()
    if (!saved) {
      if (!error.textContent) error.textContent = (remove ? labels.removeFailed : labels.saveFailed) ?? ""
      return
    }
    if (!remove) input.value = ""
    if (taskId !== undefined) document.dispatchEvent(new CustomEvent("meitheal:task-reactions-changed", { detail: taskId }))
    await load(null, remove ? labels.removed : labels.saved)
  }

  retry.addEventListener("click", () => void load(retryCursor), { signal })
  newest.addEventListener("click", () => void load(null), { signal })
  older.addEventListener("click", () => { if (nextCursor) void load(nextCursor) }, { signal })
  list.addEventListener("click", event => {
    const remove = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-remove]")
    if (remove) void mutate(remove)
  }, { signal })
  form.addEventListener("click", event => {
    const emoji = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-emoji]")
    if (busy || !emoji?.dataset.reactionEmoji) return
    input.value = emoji.dataset.reactionEmoji
    input.focus()
  }, { signal })
  form.addEventListener("submit", event => {
    event.preventDefault()
    void mutate()
  }, { signal })
  panel.addEventListener("toggle", () => { if (panel.open) void load(pageCursor) }, { signal })
  void load(null)
}
