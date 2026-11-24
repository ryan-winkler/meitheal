import { safeFetch } from "./safe-fetch"

interface AreaChoice { id: string; name: string }
interface TaskLocation { id: string | null; version: number; locationRevision: number }

export function initHomeAssistantAreaFields(signal: AbortSignal) {
  const fields = document.querySelectorAll<HTMLElement>("[data-ha-area-field]")
  if (!fields.length) return
  const proof = fields[0]?.dataset.haAreaProof
  const clearFields = () => {
    for (const field of fields) field.dispatchEvent(new Event("meitheal:ha-location-clear"))
  }
  let checking = false
  let valid = true
  async function verify(reveal: boolean) {
    if (checking || signal.aborted || document.hidden || !navigator.onLine) return
    checking = true
    try {
      const response = await safeFetch("/api/ha/areas", { method: "HEAD", signal, cache: "no-store" })
      if (signal.aborted) return
      valid = response.headers.get("x-meitheal-area-context") === proof
      if (!valid) clearFields()
      else if (reveal) for (const field of fields) field.dispatchEvent(new Event("meitheal:ha-location-resume"))
    } catch {
      valid = false
      if (!signal.aborted) clearFields()
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => { void verify(false) }, 10_000)
  signal.addEventListener("abort", () => clearInterval(timer), { once: true })
  const suspend = () => { valid = false; clearFields() }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspend()
    else void verify(true)
  }, { signal })
  window.addEventListener("offline", suspend, { signal })
  window.addEventListener("online", () => { void verify(true) }, { signal })
  window.addEventListener("pagehide", suspend, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void verify(true) }, { signal })
  window.addEventListener("focus", () => { void verify(true) }, { signal })
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) entry.target.dispatchEvent(new Event("meitheal:ha-location-load"))
    }
  })
  signal.addEventListener("abort", () => observer.disconnect(), { once: true })

  for (const field of fields) {
    const select = field.querySelector<HTMLSelectElement>("select")!
    const filter = field.querySelector<HTMLButtonElement>("[data-ha-area-filter]")
    const none = filter ? "All locations" : "None"
    const save = field.querySelector<HTMLButtonElement>("[data-ha-area-save]")
    const retry = field.querySelector<HTMLButtonElement>("[data-ha-area-retry]")!
    const status = field.querySelector<HTMLElement>("[data-ha-area-status]")!
    const followsTaskDetail = field.dataset.haAreaField === "edit" && !field.dataset.haAreaEndpoint
    let loaded: string | undefined
    let operation: AbortController | undefined
    let version: number | undefined
    let locationRevision = 0
    let selected = ""
    let registryAvailable = false

    const reset = () => {
      select.replaceChildren(new Option(none, ""))
      select.disabled = true
      if (save) save.disabled = true
      if (filter) filter.disabled = true
      status.textContent = ""
      retry.hidden = true
    }

    const load = async () => {
      if (!valid || document.hidden) return
      const endpoint = field.dataset.haAreaEndpoint ?? ""
      if (field.dataset.haAreaField === "edit" && !endpoint) {
        operation?.abort()
        loaded = undefined
        field.hidden = true
        reset()
        return
      }
      field.hidden = false
      if (loaded === endpoint) return
      operation?.abort()
      const pending = new AbortController()
      operation = pending
      const active = AbortSignal.any([signal, pending.signal])
      loaded = endpoint
      reset()
      version = undefined
      locationRevision = 0
      selected = field.dataset.haAreaInitialId ?? ""
      registryAvailable = false
      status.textContent = "Loading locations…"
      try {
        const [registry, task] = await Promise.all([
          safeFetch("/api/ha/areas", { signal: active, cache: "no-store" }),
          endpoint ? safeFetch(endpoint, { signal: active, cache: "no-store" }) : null,
        ])
        if (active.aborted) return
        if (registry.status === 404 || task?.status === 404 || (registry.ok && registry.headers.get("x-meitheal-area-context") !== proof)) {
          field.hidden = true
          return
        }
        if (task) {
          if (!task.ok) throw new Error("Could not read the saved location")
          const data: TaskLocation = await task.json()
          selected = data.id ?? ""
          version = data.version
          locationRevision = data.locationRevision
        }
        registryAvailable = registry.ok
        const choices: AreaChoice[] = registry.ok ? (await registry.json()).areas : []
        if (active.aborted) return
        if (filter) filter.disabled = !registryAvailable && !selected
        for (const area of choices) select.add(new Option(area.name, area.id))
        if (selected && !choices.some(area => area.id === selected)) {
          select.add(new Option("Saved location unavailable", selected))
        }
        select.value = selected
        select.disabled = field.dataset.haAreaReadOnly !== undefined || (!registryAvailable && !selected)
        retry.hidden = registryAvailable
        status.textContent = registryAvailable ? "" : "Home Assistant locations are temporarily unavailable."
      } catch {
        if (!active.aborted) {
          status.textContent = "Could not load locations. Try again."
          retry.hidden = false
        }
      }
    }

    field.addEventListener("meitheal:ha-location-clear", () => {
      operation?.abort()
      loaded = undefined
      version = undefined
      locationRevision = 0
      selected = ""
      reset()
      field.hidden = true
    }, { signal })
    field.addEventListener("meitheal:ha-location-resume", () => {
      field.hidden = field.dataset.haAreaField === "edit" && !field.dataset.haAreaEndpoint
      if (field.getClientRects().length > 0) void load()
    }, { signal })
    field.addEventListener("meitheal:ha-location-load", () => { void load() }, { signal })
    document.addEventListener("meitheal:ha-location-task", event => {
      if (!followsTaskDetail || !(event instanceof CustomEvent)) return
      field.dataset.haAreaEndpoint = typeof event.detail === "string" && event.detail
        ? `/api/tasks/${encodeURIComponent(event.detail)}/home-assistant-area` : ""
      void load()
    }, { signal })
    const openId = followsTaskDetail ? document.getElementById("task-detail-overlay")?.dataset.openTaskId : undefined
    if (openId) {
      field.dataset.haAreaEndpoint = `/api/tasks/${encodeURIComponent(openId)}/home-assistant-area`
      void load()
    }
    observer.observe(field)
    if (followsTaskDetail && !field.dataset.haAreaEndpoint) {
      const openId = document.getElementById("task-detail-overlay")?.dataset.openTaskId
      if (openId) {
        field.dataset.haAreaEndpoint = `/api/tasks/${encodeURIComponent(openId)}/home-assistant-area`
        void load()
      }
    }

    retry.addEventListener("click", () => {
      loaded = undefined
      void load()
    }, { signal })
    filter?.addEventListener("click", () => {
      const url = new URL(window.location.href)
      if (select.value) url.searchParams.set("home_assistant_area_id", select.value)
      else url.searchParams.delete("home_assistant_area_id")
      url.searchParams.delete("offset")
      window.location.href = url.href
    }, { signal })
    select.addEventListener("change", () => {
      if (save) save.disabled = version === undefined || select.value === selected || (!registryAvailable && !!select.value)
    }, { signal })
    save?.addEventListener("click", async () => {
      if (save.disabled || version === undefined || !field.dataset.haAreaEndpoint) return
      const endpoint = field.dataset.haAreaEndpoint
      const value = select.value
      const active = operation ? AbortSignal.any([signal, operation.signal]) : signal
      save.disabled = true
      status.textContent = "Saving location…"
      try {
        const response = await safeFetch(endpoint, {
          method: "PUT", signal: active,
          headers: {
            "content-type": "application/json",
            ...(field.dataset.haAreaSession ? { "x-meitheal-board-session": field.dataset.haAreaSession } : {}),
          },
          body: JSON.stringify({ version, locationRevision, home_assistant_area_id: value || null }),
        })
        if (active.aborted) return
        if (response.status === 409) {
          status.textContent = "The task changed. Reload the location before saving."
          retry.hidden = false
          return
        }
        if (response.status === 403 || response.status === 404) {
          reset()
          field.hidden = true
          return
        }
        if (!response.ok) throw new Error("Location save failed")
        const result: { version: number; locationRevision: number } = await response.json()
        if (active.aborted) return
        version = result.version
        locationRevision = result.locationRevision
        selected = value
        if (field.dataset.haAreaSession) window.location.reload()
        else document.dispatchEvent(new Event("meitheal:home-assistant-area-saved"))
        status.textContent = "Location saved."
      } catch {
        if (!active.aborted) {
          save.disabled = false
          status.textContent = "Could not save the location. Your selection is still here."
        }
      }
    }, { signal })
  }
}
