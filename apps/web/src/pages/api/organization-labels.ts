import type { APIRoute } from "astro"
import { apiJson, apiProblem } from "@lib/api-response"
import { logApiError } from "@lib/api-logger"
import { readBoardRequest } from "@lib/named-board-request"
import {
  labelsProof, matchesLabelsProof, organizationLocale, parseOrganizationAliases,
  readOrganizationLabelState, renderedLabelsProof, saveOrganizationLabelState, type OrganizationLabelState,
} from "@lib/organization-labels"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const noStore = { "cache-control": "private, no-store" }

function problem(status: number, detail: string): Response {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

function response(state: OrganizationLabelState, proof: string): Response {
  const forms = Object.fromEntries(state.visible.flatMap(term => state.forms[term] ? [[term, state.forms[term]]] : []))
  const result = apiJson({ forms, revision: state.revision, terms: state.visible, proof })
  result.headers.set("cache-control", noStore["cache-control"])
  return result
}

export const GET: APIRoute = async (context) => {
  const user = verifiedIngressUser(context.locals)
  if (!user) return problem(403, "Open Meitheal through Home Assistant to use personal labels.")
  const locale = organizationLocale(context)
  try {
    return response(await readOrganizationLabelState(user.id, locale), labelsProof(user.id, locale))
  } catch (error) {
    logApiError("organization-labels", "Failed to load organization labels", error)
    return problem(503, "Personal labels are temporarily unavailable.")
  }
}

export const HEAD: APIRoute = async (context) => {
  const user = verifiedIngressUser(context.locals)
  if (!user) return new Response(null, { status: 403, headers: noStore })
  const locale = organizationLocale(context)
  try {
    const state = await readOrganizationLabelState(user.id, locale)
    return new Response(null, {
      status: 204,
      headers: { ...noStore, "x-meitheal-rendered-labels": renderedLabelsProof(user.id, locale, state, context.url.searchParams.has("settings")) },
    })
  } catch {
    return new Response(null, { status: 503, headers: noStore })
  }
}

export const PUT: APIRoute = async (context) => {
  const user = verifiedIngressUser(context.locals)
  if (!user) return problem(403, "Open Meitheal through Home Assistant to use personal labels.")
  const locale = organizationLocale(context)
  const body = await readBoardRequest(context.request)
  if (!body || typeof body.revision !== "string" || !/^(?:[0-9a-f]{32})?$/.test(body.revision)) {
    return problem(400, "Use the personal labels form in Settings.")
  }
  if (!matchesLabelsProof(body.proof, user.id, locale)) {
    return problem(412, "Your account or display language changed. Reload Settings to continue.")
  }
  try {
    const current = await readOrganizationLabelState(user.id, locale)
    if (body.revision !== current.revision ||
      !Array.isArray(body.terms) || JSON.stringify(body.terms) !== JSON.stringify(current.visible)) {
      return problem(409, "Personal labels or available features changed. Review the current settings before saving.")
    }
    const forms = parseOrganizationAliases(body.forms, current.visible)
    if (!forms) return problem(400, "Enter plain text of up to 40 characters per label.")
    if (!await saveOrganizationLabelState(user.id, locale, current, forms)) {
      return problem(409, "Personal labels changed. Review the current settings before saving.")
    }
    return new Response(null, { status: 204, headers: noStore })
  } catch (error) {
    logApiError("organization-labels", "Failed to save organization labels", error)
    return problem(503, "Personal labels are temporarily unavailable.")
  }
}
