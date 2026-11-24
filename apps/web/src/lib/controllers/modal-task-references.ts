import type { SearchResultItem } from "@domains/search"
import { fetchOnlineSearch, searchWorkerReady, searchWorkerScope } from "@lib/online-search-client"
import { commentMentionContextHeader, commentMentionToken } from "@lib/comment-mentions"
import { fetchCommentPrivate } from "@lib/comment-mention-client"
import { taskDetailPath } from "@lib/task-page-url"
import { domEl, qs, setAttr } from "@lib/dom-helpers"

const limit = 5

function referenceAtCaret(input: HTMLTextAreaElement) {
  const end = input.selectionStart
  const value = input.value
  if (input.readOnly || end !== input.selectionEnd || /^[\p{L}\p{M}\p{N}_-]/u.test(value.slice(end, end + 2))) return null
  const match = /(?:^|\s)([#@])([\p{L}\p{M}\p{N}_-]{0,40})$/u.exec(value.slice(0, end))
  if (!match || (match[1] === "@" && !input.hasAttribute("data-comment-mention"))) return null
  const kind = match[1] === "@" ? "person" : "task"
  const query = match[2] ?? ""
  return { kind, query, start: end - query.length - 1, end }
}

function ticketLabel(item: SearchResultItem): string {
  return item.subtitle?.match(/^[A-Z0-9]+-[0-9]+(?= · |$)/)?.[0] ?? "Task"
}

export function initModalTaskReferences(overlay: HTMLElement, signal: AbortSignal): () => void {
  const picker = qs<HTMLElement>(overlay, "#td-task-reference-picker")
  const status = qs<HTMLElement>(picker, '[role="status"]')
  const list = qs<HTMLElement>(picker, '[role="listbox"]')
  const home = picker?.parentElement
  if (!picker || !status || !list || !home) return () => {}

  let active: { input: HTMLTextAreaElement, token: NonNullable<ReturnType<typeof referenceAtCaret>>, lookup: AbortController } | undefined
  let timer: number | undefined
  let results: { title: string, detail: string, replacement: string }[] = []
  let selected = -1

  const close = () => {
    if (!active) return
    clearTimeout(timer)
    active.lookup.abort()
    active.input.removeAttribute("aria-controls")
    active.input.removeAttribute("aria-activedescendant")
    active = undefined
    results = []
    selected = -1
    picker.hidden = true
    list.hidden = true
    list.replaceChildren()
    status.textContent = ""
    if (picker.parentElement !== home) home.append(picker)
  }

  const isCurrent = (state: NonNullable<typeof active>) => {
    if (active !== state || document.activeElement !== state.input) return false
    const current = referenceAtCaret(state.input)
    return current?.start === state.token.start && current.end === state.token.end && current.query === state.token.query && current.kind === state.token.kind
  }

  const refresh = (event: Event) => {
    const input = event.target
    if (!(input instanceof HTMLTextAreaElement) || !input.hasAttribute("data-task-reference")) return
    close()
    if ((event instanceof InputEvent && (event.isComposing || event.inputType === "historyUndo")) || document.activeElement !== input) return
    const token = referenceAtCaret(input)
    if (!token || (token.kind === "person" && !navigator.onLine)) return
    const state = { input, token, lookup: new AbortController() }
    active = state

    timer = window.setTimeout(async () => {
      if (!isCurrent(state)) return
      input.after(picker)
      setAttr(input, "aria-controls", list.id)
      picker.hidden = false
      const person = token.kind === "person"
      setAttr(list, "aria-label", (person ? picker.dataset.personResults : picker.dataset.taskResults) ?? "")
      status.textContent = (person ? picker.dataset.personLoading : picker.dataset.loading) ?? ""
      picker.scrollIntoView({ block: "nearest" })
      try {
        const signal = AbortSignal.any([state.lookup.signal, AbortSignal.timeout(5_000)])
        if (person) {
          const response = await fetchCommentPrivate("api/comment-people", signal, {
            method: "POST",
            headers: { "content-type": "application/json", [commentMentionContextHeader]: picker.dataset.personContext ?? "" },
            body: JSON.stringify({ q: token.query }),
          })
          if (!response.ok) throw new Error("Could not look up people.")
          const { matches } = await response.json() as { matches: { key: string, label: string }[] }
          if (!isCurrent(state)) return
          results = matches.slice(0, limit).map(({ key, label }) => ({
            title: label, detail: "", replacement: commentMentionToken(key, label),
          }))
        } else {
          const params = new URLSearchParams({ scope: "tasks", task_fields: "id,title", limit: String(limit), include_completed: "1" })
          if (token.query) {
            params.set("q", token.query)
            params.set("include_archived", "1")
          }
          const scope = searchWorkerScope()
          const worker = navigator.serviceWorker?.controller
          if (worker && !await searchWorkerReady(scope, worker)) {
            if (isCurrent(state)) status.textContent = picker.dataset.update ?? ""
            return
          }
          if (!isCurrent(state) || navigator.serviceWorker?.controller !== worker) return
          const data = await fetchOnlineSearch(params, scope, signal)
          if (!isCurrent(state) || navigator.serviceWorker?.controller !== worker) return
          results = (data.sections.find(section => section.id === "tasks")?.items ?? [])
            .filter(item => item.kind === "task" && item.taskId)
            .slice(0, limit)
            .map(item => {
              const label = ticketLabel(item)
              return { title: item.title, detail: label === "Task" ? picker.dataset.taskLabel ?? "" : label,
                replacement: `[${label}](${taskDetailPath(item.taskId!)})` }
            })
        }
        list.replaceChildren(...results.map((item, index) => {
          const option = domEl("li")
          option.id = `${list.id}-${index}`
          option.dataset.index = String(index)
          setAttr(option, "role", "option")
          setAttr(option, "aria-selected", "false")
          option.className = "flex min-h-11 cursor-pointer select-none items-center gap-2 rounded px-3 py-2 hover:bg-bg-hover aria-selected:outline-2 aria-selected:-outline-offset-2 aria-selected:outline-accent"
          const title = domEl("span", "line-clamp-2 min-w-0 flex-1 wrap-anywhere")
          title.textContent = item.title
          const ticket = domEl("span", "shrink-0 text-xs text-text-secondary", item.detail)
          option.append(title)
          if (item.detail) option.append(ticket)
          return option
        }))
        list.hidden = results.length === 0
        status.textContent = (person
          ? (results.length ? picker.dataset.personChoose : picker.dataset.personEmpty)
          : (results.length ? picker.dataset.choose : picker.dataset.empty)) ?? ""
        picker.scrollIntoView({ block: "nearest" })
      } catch {
        if (isCurrent(state)) status.textContent = (person ? picker.dataset.personFailed : picker.dataset.failed) ?? ""
      }
    }, 180)
  }

  const insert = (index: number) => {
    const result = results[index]
    if (!active || !isCurrent(active) || !result) return close()
    const { input, token } = active
    const { replacement } = result
    if (input.maxLength >= 0 && input.value.length - (token.end - token.start) + replacement.length > input.maxLength) {
      status.textContent = picker.dataset.tooLong ?? ""
      return
    }
    close()
    input.focus()
    // The browser's editing command retains native textarea undo history.
    input.setSelectionRange(token.start, token.end)
    if (document.execCommand("insertText", false, replacement)) return
    input.setRangeText(replacement, token.start, token.end, "end")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  overlay.addEventListener("input", refresh, { signal })
  overlay.addEventListener("compositionend", refresh, { signal })
  overlay.addEventListener("focusout", event => { if (event.target === active?.input) close() }, { signal })
  overlay.addEventListener("click", event => { if (event.target === active?.input) close() }, { signal })
  overlay.addEventListener("keydown", event => {
    const input = active?.input
    if (!input || event.target !== input || event.isComposing || event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (results.length && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
      (event.key === "ArrowDown" || event.key === "ArrowUp" || (event.key === "Enter" && selected >= 0))) {
      event.preventDefault()
      if (event.key === "Enter") return insert(selected)
      const next = event.key === "ArrowDown" ? selected + 1 : selected < 0 ? results.length - 1 : selected - 1
      setAttr(list.children[selected], "aria-selected", "false")
      selected = (next + results.length) % results.length
      const option = list.children[selected]!
      setAttr(option, "aria-selected", "true")
      setAttr(input, "aria-activedescendant", option.id)
      option.scrollIntoView({ block: "nearest" })
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter"].includes(event.key)) {
      close()
    }
  }, { signal })
  list.addEventListener("pointerdown", event => { if (event.button === 0) event.preventDefault() }, { signal })
  list.addEventListener("click", event => {
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null
    if (option) insert(Number(option.dataset.index))
  }, { signal })
  window.addEventListener("blur", close, { signal })
  window.addEventListener("offline", () => { if (active?.token.kind === "person") close() }, { signal })
  window.addEventListener("pagehide", close, { signal })
  navigator.serviceWorker?.addEventListener("controllerchange", close, { signal })
  signal.addEventListener("abort", close, { once: true })
  return close
}
