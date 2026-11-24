/**
 * Shared contextual help modal controller for Settings sections.
 * Uses the standardized TablerModal (#settings-help-modal) and reads SSR-injected
 * JSON from #settings-help-topics so static prose stays out of client bundles.
 * Uses textContent only (zero innerHTML).
 *
 * @domain navigation
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { openTablerModal } from "@lib/tabler-modal"
import { byId, domEl, qs } from "@lib/dom-helpers"

interface HelpTopic {
  title: string
  body: string
  tip?: string
}

export interface SettingsHelpModalOptions {
  title: string
  body?: string | undefined
  paragraphs?: readonly string[] | undefined
  tip?: string | undefined
  env?: string | undefined
  trigger?: HTMLElement | undefined
}

export function openSettingsHelpModal(options: SettingsHelpModalOptions): void {
  const modal = byId("settings-help-modal")
  if (!modal) return

  const titleEl = byId("settings-help-modal-title")
  const bodyEl = qs<HTMLElement>(modal, "[data-help-body]")
  const tipEl = qs<HTMLElement>(modal, "[data-help-tip]")
  const envEl = qs<HTMLElement>(modal, "[data-help-env]")

  if (titleEl) titleEl.textContent = options.title

  if (bodyEl) {
    const lines = options.paragraphs?.length
      ? [...options.paragraphs]
      : (options.body ?? "").split(/\\n|\n/).map((line) => line.trim()).filter(Boolean)
    bodyEl.replaceChildren(...lines.map((line) => {
      const p = domEl("p")
      p.textContent = line
      return p
    }))
  }

  if (tipEl) {
    const tip = options.tip?.trim() ?? ""
    tipEl.textContent = tip
    tipEl.hidden = !tip
  }

  if (envEl) {
    const env = options.env?.trim() ?? ""
    envEl.textContent = env
    envEl.hidden = !env
  }

  void openTablerModal(modal, options.trigger)
}

export function initSettingsHelp(): void {
  const shell = byId("settings-shell")
  const dataEl = byId("settings-help-topics")
  if (!shell || !dataEl) return

  let topics: Record<string, HelpTopic> = {}
  try {
    topics = JSON.parse(dataEl.textContent || "{}") as Record<string, HelpTopic>
  } catch {
    return
  }

  pageLifecycle.on(shell, "click", (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-settings-help], [data-plg-help]")
    if (!btn) return
    event.preventDefault()
    event.stopPropagation()
    const key = btn.dataset.settingsHelp
    const topic = key ? topics[key] : undefined
    const title = topic?.title ?? btn.dataset.helpTitle
    const body = topic?.body ?? btn.dataset.helpBody
    if (!title || !body) return
    openSettingsHelpModal({
      title,
      body,
      tip: topic?.tip ?? btn.dataset.helpTip,
      trigger: btn,
    })
  })
}
