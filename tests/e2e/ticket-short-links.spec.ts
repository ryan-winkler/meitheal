import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test("short ticket links open the ticket without naming its Board", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const baseHeaders = await currentBoardWriteHeaders(request, "household", { origin })
  const title = "Short ticket link"
  const created = await request.post("/api/tasks", {
    headers: { ...baseHeaders, "content-type": "application/json" },
    data: { title },
  })
  expect(created.status(), await created.text()).toBe(201)
  const { id, ticket_key } = await created.json()
  try {
    const number = Number(String(ticket_key).split("-")[1])

    for (const [alias, key] of [
      [`/t/${ticket_key}`, ticket_key],
      [`/${String(ticket_key).toLowerCase()}`, ticket_key],
      [`/t/mth-0${number}?comment=7`, ticket_key],
    ] as const) {
      const response = await request.get(alias, { maxRedirects: 0 })
      expect(response.status(), alias).toBe(302)
      const query = alias.includes("?") ? alias.slice(alias.indexOf("?")) : ""
      expect(response.headers().location, alias).toBe(`/tickets/${key}${query}`)
    }

    await page.goto(`/${String(ticket_key).toLowerCase()}`)
    await expect(page.locator("#td-title")).toHaveValue(title)
    expect(new URL(page.url()).pathname).toMatch(new RegExp(`^/tickets/(${ticket_key}|${id})$`))

    for (const path of ["/t/not-a-ticket", "/not-a-page", "/mth-0"]) {
      const missing = await request.get(path, { maxRedirects: 0 })
      expect(missing.status(), path).toBe(404)
    }
  } finally {
    const deleted = await request.delete(`/api/tasks/${id}`, { headers: baseHeaders })
    expect(deleted.status(), await deleted.text()).toBe(204)
  }
})
