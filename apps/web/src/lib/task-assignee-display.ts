import { taskApi, type AssigneeDirectory } from "./task-api-client"

let pendingDirectory: ReturnType<typeof taskApi.listUserDirectory> | undefined

export function assigneeFallback(id: string, directory: AssigneeDirectory | null): string {
  if (!directory) return "Could not load assignee"
  return id.startsWith("ha_") && (directory.ha_roster_verified ?? directory.ha_connected) === false
    ? "Home Assistant assignee not verified"
    : "Assignee unavailable"
}

/** Resolve visible names once per rendered task surface. Keep stored IDs as references. */
export async function hydrateTaskAssignees(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const labels = root.querySelectorAll<HTMLElement>("[data-task-assignee]")
  if (!labels.length) return

  const directory = await (pendingDirectory ??= taskApi.listUserDirectory().finally(() => {
    pendingDirectory = undefined
  })).catch(() => null)
  if (signal.aborted) return
  const names = new Map(directory?.users.map(user => [user.id, user.display_name || user.name]))
  for (const label of labels) {
    const id = label.dataset.taskAssignee ?? ""
    const name = names.get(id)
    const text = name || assigneeFallback(id, directory)
    label.textContent = text
    if (label.parentElement) label.parentElement.title = name ? `Assigned to ${name}` : text
  }
}
