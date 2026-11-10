/**
 * Clipboard API — Copy task data to clipboard
 *
 * Uses the modern Clipboard API (navigator.clipboard.writeText).
 * Includes formatted markdown copy for rich task details.
 *
 * Bounded context: lib (cross-domain utility)
 */

// --- Public API ---

/**
 * Copy text to clipboard. Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Copy a task as formatted markdown.
 */
export async function copyTaskAsMarkdown(task: {
  title: string
  description?: string
  status?: string
  priority?: number
  dueDate?: string
}): Promise<boolean> {
  const lines: string[] = [
    `## ${task.title}`,
    "",
  ]

  if (task.status) lines.push(`**Status:** ${task.status}`)
  if (task.priority) lines.push(`**Priority:** ${task.priority}`)
  if (task.dueDate) lines.push(`**Due:** ${task.dueDate}`)
  if (task.description) {
    lines.push("")
    lines.push(task.description)
  }

  return copyToClipboard(lines.join("\n"))
}

