/**
 * Grocy Stock API — Stock Levels & Expiry
 *
 * GET  /api/grocy/stock — current stock levels (optional: ?query=name)
 * GET  /api/grocy/stock?expiring=3 — items expiring within N days
 *
 * Powers MCP checkGrocyStock tool and conversation agent context.
 *
 * @domain grocy
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { createGrocyClient } from "../../../lib/grocy-client"
import { logApiError } from "../../../lib/api-logger"

/**
 * GET /api/grocy/stock
 * Query params:
 *   - query: filter by product name (optional)
 *   - expiring: show items expiring within N days (optional, default: all)
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    const adapter = await createGrocyClient()
    if (!adapter) {
      return new Response(
        JSON.stringify({ ok: false, error: "Grocy not configured — set URL and API key in Settings" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const query = url.searchParams.get("query")
    const expiringDays = url.searchParams.get("expiring")

    // Fetch all stock
    const stockResult = await adapter.checkStock(query ? [query] : [])

    if (!stockResult.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: stockResult.message, errorCode: stockResult.errorCode }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    let items = stockResult.data

    // When no query filter, checkStock returns items matching [] — which is none.
    // For "get all stock", we need to call the raw stock endpoint instead.
    if (!query) {
      // Use the full stock list from the adapter
      const allStockResult = await adapter.checkStock([""])
      // checkStock filters by name.includes() — empty string matches everything
      if (allStockResult.ok) {
        items = allStockResult.data
      }
    }

    // Filter to expiring items if requested
    if (expiringDays) {
      const days = Number(expiringDays)
      if (!Number.isNaN(days) && days > 0) {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() + days)
        const cutoffStr = cutoff.toISOString().split("T")[0]!

        items = items.filter((item) => {
          if (!item.bestBeforeDate) return false
          return item.bestBeforeDate <= cutoffStr
        })
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        items,
        count: items.length,
        ...(expiringDays ? { expiringWithinDays: Number(expiringDays) } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  } catch (err) {
    logApiError("grocy-stock", "GET failed", err)
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
