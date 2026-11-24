import { browserUuid } from "./browser-uuid"

export function checklistLines(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

export function createChecklistItem(text: string) {
  return { id: browserUuid(), text, done: false }
}
