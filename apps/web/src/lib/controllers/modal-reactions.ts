import { isActiveParticipantProblem } from "@lib/task-participant-problem"
import { domEl, qs, setAttr } from "@lib/dom-helpers"

interface Reaction {
  id: number
  content: string
  author: string
  can_manage: boolean
}

interface ReactionGroup {
  content: string
  count: number
  reacted: boolean
  my_reaction_id: number | null
}

interface ReactionPage {
  reactions: Reaction[]
  groups?: ReactionGroup[]
  next_cursor: string | null
  can_react: boolean
}

export function mountReactions(host: HTMLElement, url: string, signal: AbortSignal, taskId?: string): void {
  const template = document.querySelector<HTMLTemplateElement>("#td-reaction-controls")
  if (!template || signal.aborted) return

  const panel = domEl("details", `${taskId === undefined ? "mt-2 " : ""}rounded-md border border-border px-3`)
  panel.dataset.reactionPanel = taskId === undefined ? "comment" : "task"
  const summary = domEl("summary", "min-h-11 cursor-pointer py-3 text-sm font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-accent", (taskId === undefined ? template.dataset.commentLabel : template.dataset.taskLabel) ?? "")
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
  const status = qs<HTMLElement>(panel, "[data-reaction-status]")!
  const error = qs<HTMLElement>(panel, "[data-reaction-error]")!
  const groupsBar = qs<HTMLElement>(panel, "[data-reaction-groups]")
  const list = qs<HTMLUListElement>(panel, "[data-reaction-list]")!
  const retry = qs<HTMLButtonElement>(panel, "[data-reaction-retry]")!
  const newest = qs<HTMLButtonElement>(panel, "[data-reaction-newest]")!
  const older = qs<HTMLButtonElement>(panel, "[data-reaction-older]")!
  const form = qs<HTMLFormElement>(panel, "[data-reaction-form]")!
  const input = qs<HTMLInputElement>(form, "input")!
  let busy = false
  let pageCursor: string | null = null
  let retryCursor: string | null = null
  let nextCursor: string | null = null

  const isCurrent = () => !signal.aborted && panel.isConnected

  function setBusy(value: boolean): void {
    busy = value
    setAttr(list, "aria-busy", String(value))
    input.readOnly = value
  }

  function render(reaction: Reaction): HTMLLIElement {
    const row = domEl("li", "flex min-h-11 flex-wrap items-center gap-x-2 rounded-md bg-bg-input px-2 text-sm wrap-anywhere")
    const content = domEl("bdi", "font-medium text-text-primary")
    content.textContent = reaction.content
    const author = domEl("bdi", "text-text-secondary")
    author.textContent = reaction.author
    row.append(content, author)
    if (reaction.can_manage) {
      const remove = domEl("button")
      remove.type = "button"
      remove.className = "btn btn-ghost ms-auto min-h-11"
      remove.dataset.reactionRemove = String(reaction.id)
      remove.textContent = labels.remove ?? ""
      setAttr(remove, "aria-label", labels.removeDescription?.replace("{reaction}", () => reaction.content) ?? "")
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
      if (groupsBar) {
        const groups = Array.isArray(data.groups) ? data.groups : []
        groupsBar.hidden = groups.length === 0
        groupsBar.replaceChildren(...groups.map(group => {
          const pill = domEl("button")
          pill.type = "button"
          pill.className = "btn btn-sm border border-border rounded-full px-2.5 py-0.5 text-xs aria-pressed:border-accent aria-pressed:bg-accent/15 aria-pressed:text-accent"
          pill.dataset.reactionGroup = group.content
          setAttr(pill, "aria-pressed", String(Boolean(group.reacted)))
          pill.disabled = !data.can_react && !group.reacted
          if (group.my_reaction_id != null) pill.dataset.myReactionId = String(group.my_reaction_id)
          pill.textContent = `${group.content} (${group.count})`
          return pill
        }))
      }
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

  async function mutate(removeId?: string, presetContent?: string): Promise<void> {
    if (busy || !isCurrent()) return
    const content = (presetContent ?? input.value).trim().normalize("NFC")
    const length = [...content].length
    error.textContent = ""
    if (!removeId && (length === 0 || length > 16)) {
      error.textContent = labels.invalid ?? ""
      input.focus()
      return
    }
    let saved = false
    setBusy(true)
    status.textContent = labels.saving ?? ""
    try {
      const safeRemoveId = removeId && /^[\w-]+$/.test(removeId) ? encodeURIComponent(removeId) : null
      if (removeId && !safeRemoveId) {
        error.textContent = labels.removeFailed ?? ""
        return
      }
      const response = await fetch(safeRemoveId ? `${url}/${safeRemoveId}` : url, { // nosemgrep
        method: safeRemoveId ? "DELETE" : "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ...(safeRemoveId ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) }),
      })
      const participantDenied = await isActiveParticipantProblem(response)
      if (!isCurrent()) return
      saved = response.ok
      if (participantDenied) error.textContent = labels.participantRequired ?? ""
      else if (!removeId && response.status === 400) error.textContent = labels.invalid ?? ""
    } catch {
      // Keep the draft and the current page available for retry.
    } finally {
      if (isCurrent()) {
        setBusy(false)
        status.textContent = ""
      }
    }
    if (!isCurrent()) return
    if (!removeId && panel.open && form.contains(document.activeElement)) input.focus()
    if (!saved) {
      if (!error.textContent) error.textContent = (removeId ? labels.removeFailed : labels.saveFailed) ?? ""
      return
    }
    if (!removeId && presetContent === undefined) input.value = ""
    if (taskId !== undefined) document.dispatchEvent(new CustomEvent("meitheal:task-reactions-changed", { detail: taskId }))
    await load(null, removeId ? labels.removed : labels.saved)
  }

  retry.addEventListener("click", () => void load(retryCursor), { signal })
  newest.addEventListener("click", () => void load(null), { signal })
  older.addEventListener("click", () => { if (nextCursor) void load(nextCursor) }, { signal })
  groupsBar?.addEventListener("click", event => {
    const pill = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-group]")
    if (!pill || pill.disabled) return
    if (pill.getAttribute("aria-pressed") === "true" && pill.dataset.myReactionId) {
      void mutate(pill.dataset.myReactionId)
    } else if (pill.dataset.reactionGroup) {
      void mutate(undefined, pill.dataset.reactionGroup)
    }
  }, { signal })
  list.addEventListener("click", event => {
    const remove = (event.target as Element).closest<HTMLButtonElement>("[data-reaction-remove]")
    if (remove?.dataset.reactionRemove) void mutate(remove.dataset.reactionRemove)
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
