import { createHash } from "node:crypto"
import sanitizeHtml from "sanitize-html"
import { getCachedHAUserName } from "@domains/ha/ha-users"
import { verifiedIngressUser } from "./verified-ingress-user"

function plainName(name: string): string {
  return sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 80)
}

function ownerKey(kind: "automation" | "home-assistant", id: string): string {
  return createHash("sha256").update(`comment-owner:${kind}:${id}`).digest("hex")
}

export function resolveTaskAuthor(locals: App.Locals): { author: string, owner: string | null } | null {
  if (locals.agentToken) {
    const name = plainName(locals.agentToken.tokenName)
    return {
      author: name ? `Automation: ${name}` : "Automation",
      owner: ownerKey("automation", locals.agentToken.tokenId),
    }
  }
  if (!locals.behindIngress) return { author: "Local user", owner: null }

  const user = verifiedIngressUser(locals)
  if (!user) return null
  const name = plainName(getCachedHAUserName(user.id) ?? "")
  const owner = ownerKey("home-assistant", user.id)
  if (name) return { author: name, owner }
  const reference = createHash("sha256").update(`comment-author:${user.id}`).digest("hex").slice(0, 10)
  return { author: `Home Assistant member · ${reference}`, owner }
}
