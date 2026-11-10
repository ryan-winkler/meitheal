import type { APIRoute } from "astro"
import { apiJson } from "../../../lib/api-response"

/** Idempotent hook acknowledgement: preparation never locks or pauses writes. */
export const POST: APIRoute = async () => apiJson({ ok: true, writes_paused: false })
