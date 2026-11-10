import type { APIRoute } from "astro"
import { verifyLicenseKey } from "@meitheal/domain-auth"
import { apiJson } from "../../../lib/api-response"

/**
 * GET /api/license/status — License key validation endpoint.
 *
 * Reads the MEITHEAL_LICENSE_KEY env var (set by run.sh from add-on config)
 * and returns the verification result. No sensitive data is exposed —
 * the key itself is never returned, only the validation outcome.
 */
export const GET: APIRoute = async () => {
  const key = process.env.MEITHEAL_LICENSE_KEY || ""
  const result = verifyLicenseKey(key)

  return apiJson({
    ...result,
    // Never expose the raw key
    _source: key ? "config" : "none"
  })
}
