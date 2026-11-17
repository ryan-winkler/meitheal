import sanitizeHtml from "sanitize-html"

import { formatTicketKey } from "./ticket-key"

const titleCharacters = { amp: "&", lt: "<", gt: ">" }

/** A readable scoped Epic reference also distinguishes equal or unavailable titles. */
export function getEpicGroupLabel(epic: { id: string; title: string | null; ticket_number: number | null }): string {
  const title = sanitizeHtml(epic.title ?? "", { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt);/g, (_, entity: keyof typeof titleCharacters) => titleCharacters[entity])
    .replace(/\s+/g, " ").trim()
  const reference = formatTicketKey(epic.ticket_number) ?? `#${epic.id}`
  return title ? `${title} (${reference})` : reference
}
