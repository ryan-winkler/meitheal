export function taskDraftText(key: string): string {
  return window.mI18n?.get("task_draft." + key) ?? key
}
