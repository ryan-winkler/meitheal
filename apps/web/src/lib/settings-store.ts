export interface SettingsStore {
  load(): Promise<Record<string, unknown>>
  saveSetting(key: string, value: unknown): Promise<void>
  invalidate(): void
}

let cachedSettings: Record<string, unknown> | null = null
let pendingLoad: Promise<Record<string, unknown>> | null = null

async function fetchAllSettings(): Promise<Record<string, unknown>> {
  const response = await fetch((window.__ingress_path || "") + "/api/settings")
  if (!response.ok) {
    throw new Error(`Settings bootstrap failed: ${response.status}`)
  }

  const payload = (await response.json()) as Record<string, unknown>
  cachedSettings = payload
  return payload
}

export function createSettingsStore(): SettingsStore {
  return {
    async load(): Promise<Record<string, unknown>> {
      if (cachedSettings) return cachedSettings
      if (!pendingLoad) {
        pendingLoad = fetchAllSettings().finally(() => {
          pendingLoad = null
        })
      }

      return pendingLoad
    },

    async saveSetting(key: string, value: unknown): Promise<void> {
      const response = await fetch((window.__ingress_path || "") + "/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      })

      if (!response.ok) {
        throw new Error(`Settings save failed: ${response.status}`)
      }

      cachedSettings = {
        ...(cachedSettings ?? {}),
        [key]: value,
      }
    },

    invalidate(): void {
      cachedSettings = null
      pendingLoad = null
    },
  }
}

export const settingsStore = createSettingsStore()
