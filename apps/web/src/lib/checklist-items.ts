export function checklistLines(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

export function createChecklistItem(text: string) {
  // Ingress can also be served over local HTTP, where randomUUID is unavailable.
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("")
  return { id, text, done: false }
}
