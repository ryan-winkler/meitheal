import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { closeHAConnection, getHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import {
  pushTaskToCalendar,
  startCalendarSync,
  stopCalendarSync,
  syncFromHA,
} from "../../apps/web/src/domains/calendar/calendar-bridge"
import { t } from "../../apps/web/src/i18n/translations"
import enCatalog from "../../apps/web/src/i18n/en.json" with { type: "json" }
import gaCatalog from "../../apps/web/src/i18n/ga.json" with { type: "json" }

const { WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")

test.describe("Track C — Evergreen Carbon Surfaces, Tabler 1.75px Sprites & 5-Bucket Emoji Pass", () => {
  test("calendar-bridge outbound attribution and inbound stripping round-trip cleanly (Bucket 1 preserved)", async () => {
    const previous = Object.fromEntries(
      ["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]),
    )
    const dir = await mkdtemp(join(tmpdir(), "meitheal-track-c-cal-"))
    const createdPayloads: Array<Record<string, unknown>> = []
    let inboundEvents: Array<Record<string, unknown>> = []

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await new Promise<void>((resolve) => wss.once("listening", resolve))
    wss.on("connection", (socket: { send(v: string): void; on(e: string, cb: (raw: Buffer) => void): void }) => {
      socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.1" }))
      socket.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "auth") {
          socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.1" }))
          return
        }
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ id: msg.id, type: "pong" }))
          return
        }
        if (msg.type === "call_service" && msg.domain === "calendar" && msg.service === "create_event") {
          createdPayloads.push(msg.service_data ?? {})
          socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }))
          return
        }
        if (msg.type === "call_service" && msg.domain === "calendar" && msg.service === "get_events") {
          socket.send(
            JSON.stringify({
              id: msg.id,
              type: "result",
              success: true,
              result: { response: { [msg.target.entity_id]: { events: inboundEvents } } },
            }),
          )
          return
        }
        socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: msg.type === "get_states" ? [] : null }))
      })
    })

    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = `http://127.0.0.1:${wss.address().port}`
    process.env.HA_TOKEN = "track-c-cal-token"
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
    resetPersistenceForTests()
    const db = getPersistenceClient()

    try {
      await ensureSchema()
      expect(await getHAConnection()).not.toBeNull()
      startCalendarSync({
        entityId: "calendar.household",
        syncEnabled: true,
        syncMode: "bidirectional",
        writeBack: true,
        syncIntervalMs: 0,
      })

      await db.execute({
        sql: `INSERT INTO tasks (id, title, description, status, priority, due_date, labels, framework_payload, calendar_sync_state, area_id, custom_fields, task_type, idempotency_key, request_id, ticket_number, created_at, updated_at)
              VALUES ('task-cal-1', 'Service heat pump', 'Initial note', 'active', 2, '2026-11-20', '["homelab","hvac"]', '{}', 'pending', 'default', '{}', 'task', 'idem-cal-1', 'req-cal-1', 42, ?, ?)`,
        args: [Date.now(), Date.now()],
      })

      const pushed = await pushTaskToCalendar(
        "task-cal-1",
        "Service heat pump",
        "2026-11-20",
        "Check glycol loop pressure\n\nRecord manifold reading",
        "calendar.household",
        {
          ticketKey: "MTH-42",
          status: "active",
          priority: 2,
          labels: ["homelab", "hvac", "calendar-sync"],
          checklists: [
            { text: "Inspect strainer", done: true },
            { text: "Flush air separator", done: false },
          ],
        },
      )
      expect(pushed).toBe(true)
      expect(createdPayloads).toHaveLength(1)

      const outboundDesc = String(createdPayloads[0]?.description ?? "")
      expect(outboundDesc).toContain("📋 MTH-42")
      expect(outboundDesc).toContain("🟠 High")
      expect(outboundDesc).toContain("🏷️ homelab, hvac")
      expect(outboundDesc).toContain("📝 Checklist (1/2)")
      expect(outboundDesc).toContain("✅ Inspect strainer")
      expect(outboundDesc).toContain("☐ Flush air separator")
      expect(outboundDesc).toContain("Added from Meitheal")

      // 1. Untouched outbound payload triggers "Added from Meitheal" loop-prevention guard
      inboundEvents = [
        {
          uid: "inbound-loop-guard-uid",
          summary: "Service heat pump loop guard",
          description: outboundDesc,
          start: "2026-11-21",
          end: "2026-11-22",
        },
      ]
      const loopCounts = await syncFromHA("calendar.household")
      expect(loopCounts.created).toBe(0)
      expect(loopCounts.updated).toBe(0)

      // 2. Edited HA event matching existing task strips Bucket 1 emoji attribution lines via stripMeithealAttribution
      inboundEvents = [
        {
          uid: "inbound-roundtrip-uid",
          summary: "Service heat pump",
          description: outboundDesc.replace(/\nAdded from Meitheal$/, ""),
          start: "2026-11-21",
          end: "2026-11-22",
        },
      ]
      const counts = await syncFromHA("calendar.household")
      expect(counts.updated).toBe(1)

      const updated = await db.execute({
        sql: "SELECT title, description FROM tasks WHERE id = ?",
        args: ["task-cal-1"],
      })
      expect(updated.rows).toHaveLength(1)
      expect(updated.rows[0]?.description).toBe("Check glycol loop pressure\n\nRecord manifold reading")
    } finally {
      stopCalendarSync()
      stopEntitySubscription()
      closeHAConnection()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(resolve))
      db.close()
      resetPersistenceForTests()
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("locale catalogs preserve Bucket 2 <option> strings and strip Bucket 5 chrome emojis", () => {
    // Bucket 2 preserved
    expect(t("settings.cal_sync_bidirectional", "en")).toContain("↔")
    expect(t("settings.cal_sync_bidirectional", "ga")).toContain("↔")
    expect(enCatalog.task_modal.priority_urgent).toContain("🔴")
    expect(gaCatalog.task_modal.priority_urgent).toContain("🔴")

    // Bucket 5 stripped
    expect(enCatalog.settings.ha_agent_title).toBe("HA Conversation Agent")
    expect(gaCatalog.settings.ha_agent_title).not.toContain("🏠")
    expect(enCatalog.command_palette.new_task).toBe("New task")
    expect(enCatalog.gamification.streak_milestone).toBe("{count} day streak!")
  })

  test.describe("Browser Surface, Sprite & Personal Accent Verification", () => {
    test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

    test("zero nested <svg>, complete <IconSpriteDefs /> coverage, 1.75px stroke, and zero backdrop-filter across routes", async ({
      page,
      request,
      baseURL,
    }) => {
      const headers = { origin: new URL(baseURL!).origin }
      const createdIds: string[] = []
      try {
        for (const taskType of ["epic", "story", "bug", "task"]) {
          const res = await request.post("/api/tasks", {
            headers,
            data: {
              title: `Sprite ${taskType} check`,
              task_type: taskType,
              priority: 1,
              due_date: new Date().toISOString().slice(0, 10),
            },
          })
          expect(res.status()).toBe(201)
          createdIds.push((await res.json()).id)
        }

        const routes = ["/", "/tasks", "/eisenhower", "/settings#integrations-settings", "/tasks?view=timeline#timeline"]
        for (const route of routes) {
          await page.goto(route)
          await page.waitForLoadState("networkidle")

          const audit = await page.evaluate(() => {
            const nestedSvgs = document.querySelectorAll("svg svg").length
            const useEls = Array.from(document.querySelectorAll<SVGUseElement>('svg use[href^="#mt-icon-"]'))
            const missingSymbols: string[] = []
            for (const u of useEls) {
              const href = u.getAttribute("href")
              if (!href) continue
              const sym = document.querySelector(`#mt-icon-sprite-defs symbol${href}`)
              if (!sym || sym.children.length === 0) missingSymbols.push(href)
            }

            const blurred: string[] = []
            for (const el of document.querySelectorAll<HTMLElement>("body, body *")) {
              const cs = getComputedStyle(el)
              const bf = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none"
              if (bf !== "none") {
                blurred.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className}:${bf}`)
              }
            }

            const iconStrokes = Array.from(document.querySelectorAll<SVGSVGElement>("svg.icon, svg.task-type-icon")).map((s) => ({
              strokeWidth: s.getAttribute("stroke-width"),
              vectorEffect: s.getAttribute("vector-effect"),
            }))

            return {
              nestedSvgs,
              spritedUseCount: useEls.length,
              missingSymbols,
              blurred,
              iconStrokes,
            }
          })

          expect(audit.nestedSvgs, `nested <svg> on ${route}`).toBe(0)
          expect(audit.spritedUseCount, `sprited <use> on ${route}`).toBeGreaterThan(0)
          expect(audit.missingSymbols, `missing <symbol> defs on ${route}`).toEqual([])
          expect(audit.blurred, `computed backdrop-filter on ${route}`).toEqual([])
          for (const st of audit.iconStrokes) {
            expect(st.strokeWidth).toBe("1.75")
            expect(st.vectorEffect).toBe("non-scaling-stroke")
          }
        }

        // Open New Task modal, SearchHub, and FrameworkWizard on /settings to verify modal surfaces & Bucket 2 <option> entries
        await page.goto("/settings#rules-settings")
        await page.waitForLoadState("networkidle")
        const wizardOptionTexts = await page.evaluate(() => {
          const tpl = document.getElementById("fw-badge-template") as HTMLTemplateElement | null
          if (!tpl) return []
          return Array.from(tpl.content.querySelectorAll("select option")).map((o) => o.textContent ?? "")
        })
        expect(wizardOptionTexts.some((t) => t.includes("🔴"))).toBe(true)

        await page.goto("/tasks")
        await page.waitForLoadState("networkidle")
        await page.keyboard.press("/")
        await expect(page.locator("#search-hub-overlay")).toBeVisible()
        const modalBlurCount = await page.evaluate(() => {
          let count = 0
          for (const el of document.querySelectorAll<HTMLElement>("#search-hub-overlay, #search-hub-overlay *, #new-task-overlay, #new-task-overlay *")) {
            const bf = getComputedStyle(el).backdropFilter
            if (bf && bf !== "none") count++
          }
          return count
        })
        expect(modalBlurCount).toBe(0)
      } finally {
        for (const id of createdIds) {
          await request.delete(`/api/tasks/${id}`, { headers })
        }
      }
    })

    test("personal accent CSS variable binding dynamically updates --accent chrome", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto("/pillars")
      await page.waitForLoadState("networkidle")

      const resolvedAccent = await page.evaluate(() => {
        document.documentElement.style.setProperty("--personal-accent", "#e11d48")
        document.documentElement.style.setProperty("--personal-accent-hover", "#be123c")
        document.documentElement.style.setProperty("--personal-accent-foreground", "#ffffff")
        return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase()
      })

      expect(resolvedAccent).toBe("#e11d48")
      // #e11d48 === rgb(225, 29, 72); auto-retry across any 0.01ms reduced-motion CSS transition frame
      await expect(page.locator("#pillar-add-btn")).toHaveCSS("background-color", "rgb(225, 29, 72)")
    })
  })
})
