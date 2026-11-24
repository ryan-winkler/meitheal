import { safeFetch } from "./safe-fetch"

interface AreaPolicySettings {
  features: Record<string, { audience: string; revision: string | null; users: string[] }>
  roster: { id: string; name: string }[]
}

export function initSettingsHomeAssistantArea(signal: AbortSignal) {
  const form = document.querySelector<HTMLFormElement>("#ha-area-feature-form")
  const feature = form?.querySelector<HTMLSelectElement>('select[name="feature"]')
  const fields = form?.querySelector<HTMLFieldSetElement>("fieldset")
  const select = form?.querySelector<HTMLSelectElement>('select[name="audience"]')
  const roster = form?.querySelector<HTMLFieldSetElement>("[data-ha-area-roster]")
  const users = form?.querySelector("[data-ha-area-users]")
  const status = form?.querySelector<HTMLElement>("[data-ha-area-policy-status]")
  if (!form || !feature || !fields || !select || !roster || !users || !status) return

  const path = "/api/organization-features"
  const ready = fields
  const choice = select
  const people = users
  const message = status
  let revision: string | null = null
  let proof: string | null = null
  let refreshing = false
  let settings: AreaPolicySettings | undefined
  const featureChoice = feature
  const showFeature = () => {
    const policy = settings?.features[featureChoice.value]
    if (!policy) return
    revision = policy.revision
    choice.value = policy.audience
    for (const input of people.querySelectorAll<HTMLInputElement>("input")) input.checked = policy.users.includes(input.value)
    setRosterVisibility()
  }
  feature.addEventListener("change", showFeature, { signal })

  const setRosterVisibility = () => { roster.hidden = select.value !== "selected" }
  select.addEventListener("change", setRosterVisibility, { signal })

  async function refresh() {
    const response = await safeFetch(path, { signal, cache: "no-store" })
    if (!response.ok) throw new Error("Could not check feature availability.")
    const data: AreaPolicySettings = await response.json()
    if (signal.aborted) return
    proof = response.headers.get("x-meitheal-area-admin")
    settings = data
    const policy = data.features[featureChoice.value]!
    revision = policy.revision
    choice.value = policy.audience
    people.replaceChildren(...data.roster.map(user => {
      const label = document.createElement("label")
      label.className = "form-check"
      const input = document.createElement("input")
      input.type = "checkbox"
      input.name = "people"
      input.value = user.id
      input.checked = policy.users.includes(user.id)
      label.append(input, document.createTextNode(user.name))
      return label
    }))
    setRosterVisibility()
    ready.disabled = false
    message.textContent = ""
  }

  form.addEventListener("submit", async event => {
    event.preventDefault()
    if (ready.disabled) return
    const selected = new FormData(form).getAll("people")
    ready.disabled = true
    message.textContent = ""
    try {
      const response = await safeFetch(path, {
        method: "PUT", signal, headers: { "content-type": "application/json", "x-meitheal-area-admin": proof ?? "" },
        body: JSON.stringify({
          feature: featureChoice.value, revision, audience: choice.value,
          users: choice.value === "selected" ? selected : [],
        }),
      })
      if (response.status === 403 || response.status === 412) {
        forget()
        return
      }
      if (response.status === 409) {
        await refresh()
        if (!signal.aborted) message.textContent = "Availability changed. Review the current selection and try again."
        return
      }
      if (!response.ok) throw new Error("Could not save feature availability.")
      await refresh()
      if (!signal.aborted) message.textContent = "Availability saved."
    } catch {
      if (!signal.aborted) message.textContent = "Could not confirm the save. Check your connection and retry."
    } finally {
      if (!signal.aborted) ready.disabled = !proof
    }
  }, { signal })

  const forget = () => {
    proof = null
    ready.disabled = true
    people.replaceChildren()
    message.textContent = "Your access changed. Reopen Settings to use feature availability."
  }
  async function verifyAdmin() {
    if (refreshing || !proof || signal.aborted || document.hidden) return
    refreshing = true
    try {
      const response = await safeFetch(path, { method: "HEAD", signal, cache: "no-store" })
      if (signal.aborted) return
      if (response.headers.get("x-meitheal-area-admin") !== proof) forget()
      else {
        ready.disabled = false
        people.removeAttribute("hidden")
      }
    } catch {
      if (!signal.aborted) forget()
    } finally {
      refreshing = false
    }
  }
  const pauseRoster = () => {
    if (!proof) return
    ready.disabled = true
    people.setAttribute("hidden", "")
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseRoster()
    else void verifyAdmin()
  }, { signal })
  window.addEventListener("pagehide", pauseRoster, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void verifyAdmin() }, { signal })
  window.addEventListener("focus", () => { void verifyAdmin() }, { signal })
  const timer = setInterval(() => { void verifyAdmin() }, 15_000)
  signal.addEventListener("abort", () => clearInterval(timer), { once: true })

  void refresh().catch(() => {
    if (!signal.aborted) message.textContent = "Could not check current availability. Reopen Settings to try again."
  })
}
