import type { Principle } from "@domains/pillars/principle-service"
import { confirmDialog } from "@lib/confirm-dialog"
import { renderMarkdownPreviewInto } from "@lib/task-description-editor"
import { pageLifecycle } from "@lib/page-lifecycle"
import { renderIconOrCustomEmoji } from "@lib/tabler-svg"

interface LinkedGoalSummary {
  id: string
  title: string
  status: string
}

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
  linkedGoals?: LinkedGoalSummary[]
  personal?: boolean
  opener?: HTMLElement
  showPrincipleForm?: boolean
}

function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T | null
}

function createShieldIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "12")
  svg.setAttribute("height", "12")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "currentColor")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z")
  svg.appendChild(path)
  return svg
}

function renderPrinciples(list: HTMLElement, principles: Principle[], editingPrincipleId: string | null = null) {
  const sorted = [...principles].sort((a, b) => Number(b.isNonNegotiable) - Number(a.isNonNegotiable) || a.position - b.position)
  if (sorted.length === 0) {
    const empty = document.createElement("li")
    empty.className = "pillar-detail-modal__principles-empty"
    empty.textContent = "No principles yet. Add a boundary for this pillar."
    list.replaceChildren(empty)
    return
  }
  const items = sorted.map(p => {
    const li = document.createElement("li")
    li.className = "pillar-detail-modal__principle-item"
    li.dataset.principleId = p.id

    if (editingPrincipleId === p.id) {
      const editForm = document.createElement("form")
      editForm.className = "pillar-detail-modal__principle-edit-form"
      editForm.dataset.editPrincipleForm = p.id

      const editInput = document.createElement("input")
      editInput.type = "text"
      editInput.className = "form-input bg-bg-input pillar-detail-modal__principle-input"
      editInput.name = "statement"
      editInput.value = p.statement
      editInput.maxLength = 500
      editInput.required = true
      editInput.setAttribute("aria-label", "Edit principle statement")

      const nnLabel = document.createElement("label")
      nnLabel.className = "pillar-detail-modal__nn-label"
      const nnCheck = document.createElement("input")
      nnCheck.type = "checkbox"
      nnCheck.className = "pillar-detail-modal__nn-check"
      nnCheck.name = "isNonNegotiable"
      nnCheck.checked = p.isNonNegotiable
      nnLabel.append(nnCheck, document.createTextNode(" Non-Negotiable"))

      const formActions = document.createElement("div")
      formActions.className = "pillar-detail-modal__principle-edit-actions"
      const saveBtn = document.createElement("button")
      saveBtn.type = "submit"
      saveBtn.className = "btn btn-primary btn-sm"
      saveBtn.textContent = "Save"

      const cancelBtn = document.createElement("button")
      cancelBtn.type = "button"
      cancelBtn.className = "btn btn-secondary btn-sm"
      cancelBtn.dataset.action = "cancel-edit-principle"
      cancelBtn.textContent = "Cancel"

      formActions.append(cancelBtn, saveBtn)
      editForm.append(editInput, nnLabel, formActions)
      li.appendChild(editForm)
      return li
    }

    const copy = document.createElement("div")
    copy.className = "pillar-detail-modal__principle-copy"
    const text = document.createElement("span")
    text.className = "pillar-detail-modal__principle-text"
    text.textContent = p.statement
    copy.appendChild(text)
    if (p.isNonNegotiable) {
      const badge = document.createElement("span")
      badge.className = "pillar-detail-modal__principle-nn-badge"
      badge.append(createShieldIcon(), document.createTextNode(" Non-Negotiable"))
      copy.appendChild(badge)
    }

    const actions = document.createElement("div")
    actions.className = "pillar-detail-modal__principle-actions"

    const editBtn = document.createElement("button")
    editBtn.type = "button"
    editBtn.className = "btn btn-secondary btn-sm"
    editBtn.dataset.action = "edit-principle"
    editBtn.textContent = "Edit"

    const toggleBtn = document.createElement("button")
    toggleBtn.type = "button"
    toggleBtn.className = "btn btn-secondary btn-sm"
    toggleBtn.dataset.action = "toggle-nn"
    toggleBtn.setAttribute("aria-pressed", String(p.isNonNegotiable))
    toggleBtn.textContent = "Non-Negotiable"

    const deleteBtn = document.createElement("button")
    deleteBtn.type = "button"
    deleteBtn.className = "btn btn-secondary btn-sm"
    deleteBtn.dataset.action = "delete-principle"
    deleteBtn.textContent = "Remove"

    actions.append(editBtn, toggleBtn, deleteBtn)
    li.append(copy, actions)
    return li
  })
  list.replaceChildren(...items)
}

function renderLinkedGoals(goalsSection: HTMLElement | null, goalsList: HTMLElement | null, goals: LinkedGoalSummary[] = []) {
  if (!goalsSection || !goalsList) return
  if (goals.length === 0) {
    goalsSection.hidden = true
    goalsList.replaceChildren()
    return
  }
  goalsSection.hidden = false
  goalsList.replaceChildren(
    ...goals.map(goal => {
      const li = document.createElement("li")
      li.className = "pillar-detail-modal__goal-item"
      const title = document.createElement("span")
      title.textContent = goal.title
      const status = document.createElement("span")
      status.className = "pillar-detail-modal__goal-status"
      status.textContent = goal.status
      li.append(title, status)
      return li
    }),
  )
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
  const goalsSection = element("pillar-detail-goals-section")
  const goalsList = element("pillar-detail-goals")
  if (!overlay || !list || !form || !input || !nonNegotiable || !submit || !add || !status) return

  let pillar: PillarDetail | null = null
  let editingPrincipleId: string | null = null
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
    editingPrincipleId = null
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
    renderPrinciples(list!, next, editingPrincipleId)
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
    editingPrincipleId = null
    overlay.style.setProperty("--pillar-accent", pillar.colorHex || "var(--accent)")
    const detailIcon = element("pillar-detail-icon")
    if (detailIcon) renderIconOrCustomEmoji(detailIcon, pillar.icon, "pillars", 22)
    element("pillar-detail-title")!.textContent = pillar.name
    element("pillar-detail-weight")!.textContent = `Weight ${pillar.weight}/10`
    const manifestoEl = element("pillar-detail-manifesto-text")!
    const currentPillarId = pillar.id
    if (pillar.manifesto?.trim()) {
      manifestoEl.textContent = pillar.manifesto
      void renderMarkdownPreviewInto(manifestoEl, pillar.manifesto, {
        shouldApply: () => !signal.aborted && pillar?.id === currentPillarId,
      })
    } else {
      manifestoEl.textContent = "No manifesto yet. Choose Edit to add one."
    }
    renderPrinciples(list, pillar.principles, null)
    renderLinkedGoals(goalsSection, goalsList, pillar.linkedGoals ?? [])
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
      if (editingPrincipleId) {
        editingPrincipleId = null
        renderPrinciples(list, pillar.principles, null)
        return
      }
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
      message: deleting.personal ? "Remove this Personal Pillar from active Pillars?" : `Remove "${deleting.name}" from active pillars?`,
      variant: "danger",
      confirmText: "Remove pillar",
      signal,
    })
    if (!confirmed || pillar !== deleting) return
    busy = true
    try {
      const response = await fetch(`/api/pillars/${encodeURIComponent(deleting.id)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, signal,
      })
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

  list.addEventListener("submit", event => {
    const editForm = (event.target as Element).closest<HTMLFormElement>("form[data-edit-principle-form]")
    if (!editForm || !pillar || busy) return
    event.preventDefault()
    const principleId = editForm.dataset.editPrincipleForm
    const principle = pillar.principles.find(item => item.id === principleId)
    if (!principle) return
    const statementInput = editForm.querySelector<HTMLInputElement>('input[name="statement"]')
    const nnInput = editForm.querySelector<HTMLInputElement>('input[name="isNonNegotiable"]')
    const statement = statementInput?.value.trim() ?? ""
    if (!statement) {
      setStatus("Enter a principle before saving.", true)
      statementInput?.focus()
      return
    }
    const isNonNegotiable = Boolean(nnInput?.checked)
    void savePrinciple({ action: "update", principleId: principle.id, statement, isNonNegotiable }, () => {
      if (!pillar) return
      editingPrincipleId = null
      refresh(pillar.principles.map(item => item.id === principle.id ? { ...item, statement, isNonNegotiable } : item))
      setStatus("Principle updated.")
      list.querySelector<HTMLButtonElement>(`[data-principle-id="${CSS.escape(principle.id)}"] [data-action="edit-principle"]`)?.focus()
    })
  }, { signal })

  list.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-action]")
    const principle = pillar?.principles.find(item => item.id === button?.closest<HTMLElement>("[data-principle-id]")?.dataset.principleId)
    if (!button || !principle || busy || !pillar) return
    const action = button.dataset.action
    if (action === "edit-principle") {
      editingPrincipleId = principle.id
      renderPrinciples(list, pillar.principles, editingPrincipleId)
      list.querySelector<HTMLInputElement>(`[data-edit-principle-form="${CSS.escape(principle.id)}"] input[name="statement"]`)?.focus()
      return
    }
    if (action === "cancel-edit-principle") {
      editingPrincipleId = null
      renderPrinciples(list, pillar.principles, null)
      list.querySelector<HTMLButtonElement>(`[data-principle-id="${CSS.escape(principle.id)}"] [data-action="edit-principle"]`)?.focus()
      return
    }
    const removing = action === "delete-principle"
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
