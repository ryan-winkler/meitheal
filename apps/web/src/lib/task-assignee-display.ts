import { taskApi, type AssigneeDirectory } from "./task-api-client"

const pendingDirectories = new WeakMap<AbortSignal, ReturnType<typeof taskApi.listUserDirectory>>()

export function assigneeFallback(id: string, directory: AssigneeDirectory | null): string {
  const [key, fallback] = !directory ? ["assignee_load_failed", "Could not load assignee"]
    : id.startsWith("ha_") && (directory.ha_roster_verified ?? directory.ha_connected) === false
      ? ["assignee_unverified", "Home Assistant assignee not verified"]
      : ["assignee_unavailable", "Assignee unavailable"]
  return window.mI18n?.get(`tasks.${key}`) ?? fallback
}

function distinguishAssigneeGroups(root: HTMLElement): void {
  const labels = root.querySelectorAll<HTMLElement>("[data-assignee-group]")
  if (!labels.length) return

  const titles = new Map([["", window.mI18n?.get("tasks.unassigned") ?? "Unassigned"]])
  for (const label of labels) titles.set(label.dataset.taskAssignee ?? "", label.textContent ?? "")

  const titleKey = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
  const counts = new Map<string, number>()
  for (const title of titles.values()) {
    const key = titleKey(title)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const used = new Set(counts.keys())
  const ordinals = new Map<string, number>()
  for (const id of [...titles.keys()].sort()) {
    if (!id) continue
    const title = titles.get(id)!
    const key = titleKey(title)
    if (counts.get(key) === 1) continue
    let ordinal = ordinals.get(key) ?? 0
    let candidate: string
    do { candidate = `${title} (${++ordinal})` } while (used.has(titleKey(candidate)))
    ordinals.set(key, ordinal)
    used.add(titleKey(candidate))
    titles.set(id, candidate)
  }

  for (const label of labels) {
    const id = label.dataset.taskAssignee ?? ""
    const title = titles.get(id)!
    label.textContent = title
    if (label.parentElement) label.parentElement.title = title
  }
}

/** Resolve visible names once per rendered task surface. Keep stored IDs as references. */
export async function hydrateTaskAssignees(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const labels = root.querySelectorAll<HTMLElement>("[data-task-assignee]")
  if (!labels.length) return

  distinguishAssigneeGroups(root)
  let pending = pendingDirectories.get(signal)
  if (!pending) {
    pending = taskApi.listUserDirectory(signal).finally(() => pendingDirectories.delete(signal))
    pendingDirectories.set(signal, pending)
  }
  const directory = await pending.catch(() => null)
  if (signal.aborted) return
  const names = new Map(directory?.users.map(user => [user.id, user.display_name || user.name]))
  for (const label of labels) {
    const id = label.dataset.taskAssignee ?? ""
    const name = names.get(id)
    const text = name || assigneeFallback(id, directory)
    label.textContent = text
    if (label.parentElement) {
      const title = window.mI18n?.get("tasks.assignee_title") ?? "Assigned to {name}"
      label.parentElement.title = name ? title.replace("{name}", () => name) : text
    }
  }
  distinguishAssigneeGroups(root)
}
