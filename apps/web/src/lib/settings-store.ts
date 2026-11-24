import { isWorkIntegrationSetting } from "@domains/tasks/work-integration-settings"
import { pageLifecycle } from "@lib/page-lifecycle"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"

export interface SettingsStore {
  load(): Promise<Record<string, unknown>>
  saveSetting(key: string, value: unknown, name?: string): Promise<void>
  invalidate(): void
}

let cachedSettings: Record<string, unknown> | null = null
let pendingLoad: Promise<Record<string, unknown>> | null = null

export function settingsWriteHeaders(key: string): HeadersInit {
  const headers = { "content-type": "application/json" }
  const board = isWorkIntegrationSetting(key) ? currentTaskApiContext() : null
  return board ? taskApiHeaders(board, headers) : headers
}

async function fetchAllSettings(): Promise<Record<string, unknown>> {
  const response = await fetch("/api/settings", { cache: "no-store", signal: pageLifecycle.signal })
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

    async saveSetting(key: string, value: unknown, name?: string): Promise<void> {
      const response = await fetch("/api/settings", {
        signal: pageLifecycle.signal,
        method: "PUT",
        headers: settingsWriteHeaders(key),
        body: JSON.stringify({ key, value, name }),
      })

      if (!response.ok) {
        throw new Error(`Settings save failed: ${response.status}`)
      }

      if (cachedSettings) {
        cachedSettings = name === undefined ? { ...cachedSettings, [key]: value } :
          { ...cachedSettings, [key]: value, custom_theme_name: name, theme: value ? "custom" : "dark" }
      }
    },

    invalidate(): void {
      cachedSettings = null
      pendingLoad = null
    },
  }
}

export const settingsStore = createSettingsStore()
