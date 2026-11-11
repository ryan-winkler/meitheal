import { showToast } from "./toast"

export function showTaskBatchResult(saved: number, attempted: number, successMessage: string): void {
  if (!attempted) return
  if (saved === attempted) return showToast(successMessage)
  if (!saved) return showToast("common.task_batch_failed", "error")

  const message = window.mI18n?.get("common.task_batch_partial")
    ?? "Saved {saved} of {attempted} changes. Check before retrying."
  showToast(message.replace("{saved}", String(saved)).replace("{attempted}", String(attempted)), "warning")
}
