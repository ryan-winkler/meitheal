import type { Principle } from "@domains/pillars/principle-service"
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { escapeHtml } from "@lib/safe-html"

interface PillarDetail {
  id: string
  slug: string
  name: string
  manifesto: string | null
  icon: string | null
  colorHex: string | null
  weight: number
  principles: Principle[]
  linkedGoalCount: number
  opener?: HTMLElement
  showPrincipleForm?: boolean
}

function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T | null
}

const shield = `<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`

function renderPrinciples(list: HTMLElement, principles: Principle[]) {
  const sorted = [...principles].sort((a, b) => Number(b.isNonNegotiable) - Number(a.isNonNegotiable) || a.position - b.position)
  list.innerHTML = sorted.map(p => `
    <li class="pillar-detail-modal__principle-item" data-principle-id="${escapeHtml(p.id)}">
      <div class="pillar-detail-modal__principle-copy">
        <span class="pillar-detail-modal__principle-text">${escapeHtml(p.statement)}</span>
        ${p.isNonNegotiable ? `<span class="pillar-detail-modal__principle-nn-badge">${shield} Non-Negotiable</span>` : ""}
      </div>
      <div class="pillar-detail-modal__principle-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="toggle-nn" aria-pressed="${p.isNonNegotiable}">Non-Negotiable</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="delete-principle">Remove</button>
      </div>
    </li>
  `).join("") || '<li class="pillar-detail-modal__principles-empty">No principles yet. Add a boundary for this pillar.</li>'
}

pageLifecycle.onPageLoad(signal => {
  const overlay = element("pillar-detail-overlay")
  const list = element("pillar-detail-principles")
  const form = element<HTMLFormElement>("pillar-detail-principle-form")
  const input = element<HTMLInputElement>("pillar-detail-principle-input")
  const nonNegotiable = element<HTMLInputElement>("pillar-detail-nn-check")
  const submit = element<HTMLButtonElement>("pillar-detail-principle-save")
  const add = element<HTMLButtonElement>("pillar-detail-add-principle")
  const status = element("pillar-detail-status")
  if (!overlay || !list || !form || !input || !nonNegotiable || !submit || !add || !status) return

  let pillar: PillarDetail | null = null
  let busy = false

  function showForm(show: boolean) {
    form!.hidden = !show
    add!.setAttribute("aria-expanded", String(show))
    if (show) input!.focus()
  }

  function close(restoreFocus = true) {
    if (!pillar || busy) return
    const opener = pillar.opener
    pillar = null
    overlay!.classList.remove("active")
    document.body.style.overflow = ""
    if (restoreFocus) opener?.focus()
  }

  function setStatus(message: string, error = false) {
    status!.textContent = message
    status!.toggleAttribute("data-error", error)
  }

  function refresh(next: Principle[]) {
    if (!pillar) return
    pillar.principles = next
    renderPrinciples(list!, next)
    document.dispatchEvent(new CustomEvent("pillar-principles-saved", { detail: { id: pillar.id, principles: next } }))
  }

  async function savePrinciple(data: Record<string, unknown>, update: (response: { principle?: Principle }) => void) {
    if (!pillar || busy) return
    busy = true
    submit!.disabled = true
    list!.setAttribute("aria-busy", "true")
    setStatus("Saving…")
    try {
      const response = await fetch(`/api/pillars/${encodeURIComponent(pillar.id)}/principles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal,
      })
      if (!response.ok) throw new Error("Principle save failed")
      const saved = await response.json()
      if (signal.aborted) return
      if (data.action === "create" && !saved.principle?.id) throw new Error("Invalid principle response")
      update(saved)
    } catch {
      if (!signal.aborted) setStatus("Could not save the principle. Try again.", true)
    } finally {
      busy = false
      submit!.disabled = false
      list!.removeAttribute("aria-busy")
    }
  }

  document.addEventListener("open-pillar-detail", ((event: CustomEvent<PillarDetail>) => {
    if (busy) return
    pillar = event.detail
    overlay.style.setProperty("--pillar-accent", pillar.colorHex || "var(--accent)")
    element("pillar-detail-icon")!.textContent = pillar.icon || "🏛️"
    element("pillar-detail-title")!.textContent = pillar.name
    element("pillar-detail-weight")!.textContent = `Weight ${pillar.weight}/10`
    element("pillar-detail-manifesto-text")!.textContent = pillar.manifesto || "No manifesto yet. Choose Edit pillar to add one."
    renderPrinciples(list, pillar.principles)
    form.reset()
    setStatus("")
    overlay.classList.add("active")
    document.body.style.overflow = "hidden"
    showForm(pillar.showPrincipleForm === true)
    if (form.hidden) element("pillar-detail-close")?.focus()
  }) as EventListener, { signal })

  element("pillar-detail-close")?.addEventListener("click", () => close(), { signal })
  overlay.addEventListener("click", event => {
    if (event.target === overlay) close()
  }, { signal })
  document.addEventListener("keydown", event => {
    if (!pillar || document.getElementById("meitheal-confirm-overlay")) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
    if (event.key !== "Tab") return
    const controls = [...overlay.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")]
      .filter(control => control.getClientRects().length)
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }, { signal })

  element("pillar-detail-edit-btn")?.addEventListener("click", () => {
    if (!pillar || busy) return
    const editing = pillar
    close(false)
    document.dispatchEvent(new CustomEvent("edit-pillar", { detail: editing }))
  }, { signal })

  element("pillar-detail-delete-btn")?.addEventListener("click", async () => {
    if (!pillar || busy || document.getElementById("meitheal-confirm-overlay")) return
    const deleting = pillar
    const confirmed = await confirmDialog({
      message: `Remove "${escapeHtml(deleting.name)}" from active pillars?`,
      variant: "danger",
      confirmText: "Remove pillar",
      signal,
    })
    if (!confirmed || pillar !== deleting) return
    busy = true
    try {
      const response = await fetch(`/api/pillars/${encodeURIComponent(deleting.id)}`, { method: "DELETE", signal })
      if (!response.ok) throw new Error("Pillar removal failed")
      window.location.reload()
    } catch {
      if (!signal.aborted) setStatus("Could not remove the pillar. Try again.", true)
    } finally {
      busy = false
    }
  }, { signal })

  add.addEventListener("click", () => { if (!busy) showForm(true) }, { signal })
  element("pillar-detail-principle-cancel")?.addEventListener("click", () => {
    if (busy) return
    form.reset()
    showForm(false)
    setStatus("")
    add.focus()
  }, { signal })

  form.addEventListener("submit", event => {
    event.preventDefault()
    const statement = input.value.trim()
    if (!statement) {
      setStatus("Enter a principle before saving.", true)
      input.focus()
      return
    }
    void savePrinciple({ action: "create", statement, isNonNegotiable: nonNegotiable.checked }, ({ principle }) => {
      if (!pillar || !principle) return
      refresh([...pillar.principles, principle])
      form.reset()
      showForm(false)
      setStatus(principle.isNonNegotiable ? "Non-negotiable principle saved." : "Principle saved.")
      add.focus()
    })
  }, { signal })

  list.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]")
    const principle = pillar?.principles.find(item => item.id === button?.closest<HTMLElement>("[data-principle-id]")?.dataset.principleId)
    if (!button || !principle || busy) return
    const removing = button.dataset.action === "delete-principle"
    const isNonNegotiable = !principle.isNonNegotiable
    const data = removing ? { action: "delete" } : { action: "update", isNonNegotiable }
    void savePrinciple({ ...data, principleId: principle.id }, () => {
      if (!pillar) return
      refresh(removing ? pillar.principles.filter(item => item !== principle) :
        pillar.principles.map(item => item === principle ? { ...item, isNonNegotiable } : item))
      setStatus(removing ? "Principle removed." : "Principle updated.")
      if (removing) add.focus()
      else list.querySelector<HTMLButtonElement>(`[data-principle-id="${CSS.escape(principle.id)}"] [data-action="toggle-nn"]`)?.focus()
    })
  }, { signal })
})
