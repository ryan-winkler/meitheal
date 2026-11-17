import type { APIContext } from "astro"
import { listHomeAssistantAreas } from "@domains/ha/ha-area-registry"
import { getCurrentHAUserRoster } from "@domains/ha/ha-users"
import { getOrganizationAvailability } from "./organization-availability"
import { verifiedIngressUser } from "./verified-ingress-user"

type AccessContext = Pick<APIContext, "locals" | "request">

export interface HomeAssistantAreaSelection {
  id: string | null
  revision: string
}

const requestAccess = new WeakMap<App.Locals, Promise<string | null>>()

export function homeAssistantAreaAccess(context: AccessContext): Promise<string | null> {
  let pending = requestAccess.get(context.locals)
  if (!pending) {
    pending = resolveAccess(context)
    requestAccess.set(context.locals, pending)
  }
  return pending
}

async function resolveAccess(context: AccessContext): Promise<string | null> {
  const user = verifiedIngressUser(context.locals)
  if (!user) return null
  const availability = await getOrganizationAvailability(context)
  if (!availability.includes("home_assistant_area")) return null
  const active = await getCurrentHAUserRoster(user.id, context.request.signal)
  return active ? availability.revision("home_assistant_area") : null
}


export async function resolveHomeAssistantAreaSelection(
  context: AccessContext, value: unknown,
): Promise<{ ok: true; selection: HomeAssistantAreaSelection | undefined } |
  { ok: false; status: 400 | 403 | 503; detail: string }> {
  if (value === undefined) return { ok: true, selection: undefined }
  const revision = await homeAssistantAreaAccess(context)
  if (!revision) return { ok: false, status: 403, detail: "Home Assistant Area is unavailable." }
  if (value === null) return { ok: true, selection: { id: null, revision } }
  if (typeof value !== "string" || !value.length || value.length > 150) {
    return { ok: false, status: 400, detail: "Choose an available Home Assistant Area." }
  }
  const areas = await listHomeAssistantAreas(context.request.signal)
  if (!areas) return { ok: false, status: 503, detail: "The Home Assistant area registry is unavailable. Try again when it connects." }
  if (!areas.some(area => area.id === value)) return { ok: false, status: 400, detail: "Choose an available Home Assistant Area." }
  return { ok: true, selection: { id: value, revision } }
}

export interface HomeAssistantAreaFilter {
  id: string
  revision: string
}

export async function readHomeAssistantAreaFilter(context: AccessContext, params: URLSearchParams): Promise<HomeAssistantAreaFilter | undefined> {
  const id = params.get("home_assistant_area_id")
  if (!id || id.length > 150) return undefined
  const revision = await homeAssistantAreaAccess(context)
  return revision ? { id, revision } : undefined
}
