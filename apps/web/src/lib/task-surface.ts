import { isActiveStatus } from "./status-config"

export function taskSurface(status: string, color: unknown) {
  const hex = typeof color === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : null
  return {
    "data-work-active": isActiveStatus(status) ? "" : undefined,
    "data-task-color": hex ? "" : undefined,
    style: hex ? `--knight-task-color: ${hex};` : undefined,
  }
}
