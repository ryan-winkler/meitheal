import { safeFetch } from "./safe-fetch"

export function initOrganizationLabels(signal: AbortSignal): void {
  const form = document.querySelector<HTMLFormElement>("#organization-labels-form")
  if (!form) return
  const rows = Array.from(form.querySelectorAll<HTMLElement>("[data-label-term]"))
  const status = form.querySelector<HTMLElement>("[data-label-status]")!
  const warning = form.querySelector<HTMLElement>("[data-label-warning]")!
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!
  const inputs = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLInputElement>("[data-label-form]"))
  const terms = rows.map(row => row.dataset.labelTerm!)
  const endpoint = "/api/organization-labels"

  const refresh = () => {
    const matches = new Map<string, string>()
    let duplicate = false
    for (const row of rows) {
      for (const input of inputs(row)) {
        const value = (input.value.trim() || input.placeholder).normalize("NFKC").toLocaleLowerCase()
        const term = row.dataset.labelTerm!
        const old = matches.get(value)
        if (old && old !== term) duplicate = true
        matches.set(value, term)
      }
    }
    warning.textContent = duplicate ? form.dataset.duplicate ?? "" : ""
    warning.hidden = !duplicate

    const board = rows.find(row => row.dataset.labelTerm === "board")
    if (!board) return
    const [singular, plural] = inputs(board) as [HTMLInputElement, HTMLInputElement]
    const word = singular.value.trim() || singular.placeholder
    for (const heading of form.querySelectorAll("[data-preview-heading]")) {
      heading.textContent = plural.value.trim() || plural.placeholder
    }
    const action = form.querySelector("[data-preview-action]")
    if (action) action.textContent = document.documentElement.lang === "ga" ? `${word} nua` : `New ${word}`
  }

  form.addEventListener("input", refresh, { signal })
  form.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest("[data-label-clear-all]")) {
      for (const row of rows) for (const input of inputs(row)) input.value = ""
    } else {
      const row = event.target.closest<HTMLElement>("[data-label-clear]")?.closest<HTMLElement>("[data-label-term]")
      if (!row) return
      for (const input of inputs(row)) input.value = ""
    }
    refresh()
  }, { signal })

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    submit.disabled = true
    status.textContent = ""
    try {
      const forms = Object.fromEntries(rows.map(row =>
        [row.dataset.labelTerm!, inputs(row).map(input => input.value)],
      ))
      const response = await safeFetch(endpoint, {
        method: "PUT", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof: form.dataset.proof, revision: form.dataset.revision, terms, forms }),
      })
      if (signal.aborted) return
      if (response.ok || response.status === 412 || response.status === 403) {
        window.location.reload()
        return
      }
      if (response.status === 409) {
        const latestResponse = await safeFetch(endpoint, { signal, cache: "no-store" })
        if (!latestResponse.ok) throw new Error("Label refresh failed")
        const latest = await latestResponse.json()
        if (latest.proof !== form.dataset.proof) {
          window.location.reload()
          return
        }
        if (JSON.stringify(terms) !== JSON.stringify(latest.terms)) {
          status.textContent = form.dataset.reload ?? ""
          return
        }
        form.dataset.revision = latest.revision
        for (const row of rows) {
          for (const [index, hint] of Array.from(row.querySelectorAll<HTMLElement>("[data-label-saved]")).entries()) {
            hint.textContent = `${hint.dataset.caption}: ${latest.forms?.[row.dataset.labelTerm!]?.[index] || inputs(row)[index]?.placeholder}`
            hint.hidden = false
          }
        }
        status.textContent = form.dataset.conflict ?? ""
        return
      }
      throw new Error("Label save failed")
    } catch {
      if (!signal.aborted) status.textContent = form.dataset.error ?? ""
    } finally {
      if (!signal.aborted) submit.disabled = false
    }
  }, { signal })

  refresh()
}
