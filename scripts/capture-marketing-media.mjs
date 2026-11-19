/**
 * Deterministic marketing screenshot and motion capture studio for Meitheal.
 * Captures production stills, Discourse-safe GIFs (< 2.8 MB), MP4 loops,
 * and a stitched captioned highlight reel using an isolated SQLite fixture.
 */
import { execFileSync, spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")
const WEB_DIR = join(REPO_ROOT, "apps/web")
const SERVER_ENTRY = join(WEB_DIR, "dist/server/entry.mjs")
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".planning/marketing/media")
const DOCS_SCREENSHOTS_DIR = join(REPO_ROOT, "docs/screenshots")

const MAX_README_PNG_BYTES = 300_000
const MAX_DISCOURSE_GIF_BYTES = 2_800_000

const requireFromTests = createRequire(new URL("../tests/package.json", import.meta.url))
const { chromium } = requireFromTests("@playwright/test")

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeFfmpegDrawtext(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
}

export function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    updateReadme: false,
    stillsOnly: false,
    baseUrl: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--out") {
      const nextOut = argv[++i]
      if (!nextOut) {
        throw new Error("--out requires a directory path")
      }
      options.outDir = resolve(process.cwd(), nextOut)
    } else if (arg === "--update-readme") {
      options.updateReadme = true
    } else if (arg === "--stills-only") {
      options.stillsOnly = true
    } else if (arg === "--base-url") {
      const rawUrl = argv[++i]
      if (!rawUrl) {
        throw new Error("--base-url requires a URL argument")
      }
      let parsedUrl
      try {
        parsedUrl = new URL(rawUrl)
      } catch {
        throw new Error(`Invalid --base-url value: ${rawUrl}`)
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`--base-url must use http: or https: protocol, got ${parsedUrl.protocol}`)
      }
      options.baseUrl = rawUrl.replace(/\/+$/, "")
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/capture-marketing-media.mjs [--out <dir>] [--update-readme] [--stills-only] [--base-url <url>]",
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`)
    }
  }
  return options
}

function assertTooling() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`Missing production build at ${SERVER_ENTRY}. Run: pnpm --filter @meitheal/web build`)
  }
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" })
    execFileSync("ffprobe", ["-version"], { stdio: "pipe" })
  } catch (err) {
    throw new Error(`ffmpeg/ffprobe must be installed on PATH: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function resolveFontFile() {
  const candidates = [
    "/usr/share/fonts/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf",
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const detected = execFileSync("fc-match", ["-f", "%{file}\n", "sans-serif:bold"], { encoding: "utf8" }).trim()
    if (detected && existsSync(detected)) return detected
  } catch {
    /* ignore */
  }
  throw new Error("Could not locate a bold Latin TTF font for ffmpeg drawtext captions")
}

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      const port = typeof address === "object" && address ? address.port : 0
      srv.close((closeErr) => {
        if (closeErr) reject(closeErr)
        else resolvePort(port)
      })
    })
  })
}

async function waitForHealth(baseUrl, timeoutMs = 20_000) {
  const started = Date.now()
  let lastDetail = ""
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) {
        const json = await res.json()
        if (json.status === "ok" && json.db_integrity === "ok") {
          return
        }
        lastDetail = JSON.stringify(json)
      } else {
        lastDetail = `HTTP ${res.status}`
      }
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err)
    }
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health: ${lastDetail}`)
}

function migrateDatabase(dbPath) {
  execFileSync("node", ["scripts/migrate.mjs"], {
    cwd: WEB_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      TZ: "Europe/Dublin",
      MEITHEAL_DB_URL: `file:${dbPath}`,
    },
    stdio: "pipe",
  })
}

async function startServer(dbPath, port) {
  const logs = []
  const child = spawn("node", ["scripts/serve.mjs"], {
    cwd: WEB_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      TZ: "Europe/Dublin",
      MEITHEAL_DB_URL: `file:${dbPath}`,
      MEITHEAL_STARTUP_BACKUP_HANDLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", chunk => logs.push(chunk.toString()))
  child.stderr.on("data", chunk => logs.push(chunk.toString()))

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(baseUrl)
  } catch (err) {
    child.kill("SIGTERM")
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nServer logs:\n${logs.join("")}`)
  }

  return {
    baseUrl,
    async stop() {
      if (child.killed || child.exitCode !== null) return
      await new Promise((resolveStop) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL")
          resolveStop()
        }, 5_000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolveStop()
        })
        child.kill("SIGTERM")
      })
    },
  }
}

function dublinToday(offsetDays = 0) {
  const now = new Date()
  const dublinStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  const d = new Date(`${dublinStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

async function apiCall(baseUrl, path, method, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    const reqId = res.headers.get("x-request-id") ?? "-"
    const remaining = res.headers.get("x-ratelimit-remaining") ?? "-"
    throw new Error(
      `API ${method} ${path} failed (${res.status}, req=${reqId}, rateRemaining=${remaining}): ${text}`,
    )
  }
  return text ? JSON.parse(text) : {}
}

async function seedHouseholdFixture(baseUrl) {
  const today = dublinToday(0)
  const yesterday = dublinToday(-1)
  const twoDaysAgo = dublinToday(-2)

  // Settings (Evergreen Carbon dark "Emerald Isle" default)
  await apiCall(baseUrl, "/api/settings", "PUT", { key: "theme", value: "dark" })
  await apiCall(baseUrl, "/api/settings", "PUT", { key: "locale", value: "en" })
  await apiCall(baseUrl, "/api/settings", "PUT", { key: "timezone", value: "Europe/Dublin" })
  await apiCall(baseUrl, "/api/settings", "PUT", { key: "week_start", value: "monday" })
  await apiCall(baseUrl, "/api/settings", "PUT", { key: "date_format", value: "relative" })
  await apiCall(baseUrl, "/api/settings", "PUT", { key: "feature_confetti", value: true })

  // Household members & HA automation actor
  const aoife = await apiCall(baseUrl, "/api/users/custom", "POST", {
    name: "Aoife",
    color: "#10B981",
    kind: "human",
  })
  const conor = await apiCall(baseUrl, "/api/users/custom", "POST", {
    name: "Conor",
    color: "#6366F1",
    kind: "human",
  })
  const haAgent = await apiCall(baseUrl, "/api/users/custom", "POST", {
    name: "Home Assistant",
    color: "#0EA5E9",
    kind: "agent",
  })

  // Areas
  const areaHome = await apiCall(baseUrl, "/api/areas", "POST", {
    name: "Home & Maintenance",
    icon: "🏠",
    color: "#6366F1",
  })
  const areaFamily = await apiCall(baseUrl, "/api/areas", "POST", {
    name: "Family & Errands",
    icon: "🛒",
    color: "#10B981",
  })
  const areaHomelab = await apiCall(baseUrl, "/api/areas", "POST", {
    name: "Homelab & HA",
    icon: "🖥️",
    color: "#0EA5E9",
  })
  const areaGarden = await apiCall(baseUrl, "/api/areas", "POST", {
    name: "Garden & Shed",
    icon: "🌿",
    color: "#F59E0B",
  })

  // Goals
  const goalWinter = await apiCall(baseUrl, "/api/goals", "POST", {
    title: "Winter-Ready House",
    area_id: areaHome.id,
    description: "Boiler, radiators, insulation, and seasonal checks completed before frost.",
    target_date: dublinToday(21),
  })
  const goalServer = await apiCall(baseUrl, "/api/goals", "POST", {
    title: "Zero-Drama Home Server",
    area_id: areaHomelab.id,
    description: "Verified Proxmox restores, current HA Core, and quiet smart-home alerts.",
    target_date: dublinToday(30),
  })

  // Projects (note: payload uses title)
  const projHeating = await apiCall(baseUrl, "/api/projects", "POST", {
    title: "Autumn Heating Prep",
    area_id: areaHome.id,
    goal_id: goalWinter.id,
    icon: "🔥",
    color: "#F97316",
  })
  const projReset = await apiCall(baseUrl, "/api/projects", "POST", {
    title: "Weekly Household Reset",
    area_id: areaFamily.id,
    icon: "✨",
    color: "#10B981",
  })
  const projProxmox = await apiCall(baseUrl, "/api/projects", "POST", {
    title: "Proxmox & Backup Hygiene",
    area_id: areaHomelab.id,
    goal_id: goalServer.id,
    icon: "💾",
    color: "#0EA5E9",
  })

  // Labels
  const labels = [
    ["home", "#6366F1"],
    ["errands", "#10B981"],
    ["homelab", "#0EA5E9"],
    ["ha-automation", "#38BDF8"],
    ["weekend", "#F59E0B"],
    ["quick-win", "#A855F7"],
  ]
  for (const [title, hex_color] of labels) {
    await apiCall(baseUrl, "/api/labels", "POST", { title, hex_color })
  }

  // Habits / Routines
  const habitKitchen = await apiCall(baseUrl, "/api/habits", "POST", {
    action: "create",
    name: "Evening kitchen reset",
    icon: "✨",
    cadence: "daily",
    checklists: [{ text: "Start dishwasher" }, { text: "Wipe counters" }],
  })
  await apiCall(baseUrl, "/api/habits", "POST", {
    action: "create",
    name: "Water indoor plants",
    icon: "🪴",
    cadence: "weekly",
  })
  await apiCall(baseUrl, "/api/habits", "POST", {
    action: "create",
    name: "Check HA backup status",
    icon: "💾",
    cadence: "weekly",
  })
  await apiCall(baseUrl, "/api/habits", "POST", {
    action: "complete",
    templateId: habitKitchen.id,
  })

  // Tasks — Carried forward (1 overdue by 1 day, Q1 Do First, Home Assistant sensor trigger)
  const leakSensor = await apiCall(
    baseUrl,
    "/api/tasks",
    "POST",
    {
      title: "Close back door sensor check after 21:45 alert",
      description: "Triggered by binary_sensor.back_door staying open past evening lock check.",
      status: "active",
      priority: 1,
      urgency: 5,
      importance: 5,
      start_date: yesterday,
      due_date: yesterday,
      end_date: today,
      area_id: areaHome.id,
      project_id: projHeating.id,
      assigned_to: haAgent.id,
      effort_minutes: 10,
      effort_type: "quick",
      color: "#7C2D48",
      is_favorite: 1,
      labels: ["ha-automation", "home"],
      checklists: JSON.stringify([
        { text: "Verify patio latch sensor", done: false },
        { text: "Confirm alarm panel armed", done: false },
      ]),
    },
    { "X-Automation-Source": "ha", "X-Agent-Id": "ha.evening_security" },
  )
  await apiCall(baseUrl, `/api/tasks/${leakSensor.id}`, "PUT", { is_promoted: true })

  // Tasks — Due Today (4 open tasks so WIP <= 6 warning does not trigger)
  const radiators = await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Bleed living room and hall radiators",
    description: "Upper manifold stays cool when boiler cycles on ahead of frost forecast.",
    status: "active",
    priority: 2,
    urgency: 4,
    importance: 5,
    start_date: twoDaysAgo,
    due_date: today,
    end_date: dublinToday(2),
    progress: 55,
    color: "#1E4D3B",
    is_favorite: 1,
    area_id: areaHome.id,
    project_id: projHeating.id,
    assigned_to: conor.id,
    effort_minutes: 25,
    labels: ["home"],
    framework_payload: JSON.stringify({ reach: 4, impact: 3, confidence: 0.9, effort: 1 }),
    checklists: JSON.stringify([
      { text: "Check boiler pressure (1.5 bar)", done: true },
      { text: "Bleed upstairs and downstairs", done: false },
    ]),
  })
  await apiCall(baseUrl, `/api/tasks/${radiators.id}`, "PUT", { is_promoted: true })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "School morning bags and lunchboxes",
    description: "Shared weekday checklist so anyone at home can tick off packed items.",
    status: "pending",
    priority: 2,
    urgency: 4,
    importance: 4,
    due_date: today,
    area_id: areaFamily.id,
    project_id: projReset.id,
    assigned_to: aoife.id,
    effort_minutes: 20,
    is_favorite: 1,
    labels: ["errands"],
    checklists: JSON.stringify([
      { text: "Fill water bottles and fruit", done: true },
      { text: "Pack PE kit", done: true },
      { text: "Check homework folder", done: false },
    ]),
  })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Test Proxmox snapshot restore on NVMe",
    description: "Run monthly restore drill for HAOS VM backup onto spare SSD slot.",
    status: "active",
    priority: 2,
    urgency: 3,
    importance: 5,
    start_date: twoDaysAgo,
    due_date: today,
    end_date: dublinToday(3),
    progress: 65,
    area_id: areaHomelab.id,
    project_id: projProxmox.id,
    assigned_to: conor.id,
    effort_minutes: 45,
    labels: ["homelab"],
    framework_payload: JSON.stringify({ reach: 4, impact: 3, confidence: 0.9, effort: 1 }),
  })

  const carNct = await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Book annual car NCT inspection",
    status: "pending",
    priority: 3,
    urgency: 4,
    importance: 2,
    due_date: today,
    area_id: areaFamily.id,
    assigned_to: aoife.id,
    effort_minutes: 15,
    labels: ["errands", "quick-win"],
  })

  // Tasks — Upcoming / Scheduled (spanning 1-13 days for Calendar, Timeline Gantt, Kanban and Q2/Q3/Q4)
  const boilerTask = await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Book annual gas boiler service (EUR 180)",
    status: "pending",
    priority: 2,
    urgency: 2,
    importance: 5,
    start_date: dublinToday(1),
    due_date: dublinToday(6),
    end_date: dublinToday(6),
    progress: 60,
    area_id: areaHome.id,
    project_id: projHeating.id,
    assigned_to: conor.id,
    effort_minutes: 60,
    labels: ["home"],
    framework_payload: JSON.stringify({ reach: 5, impact: 3, confidence: 0.9, effort: 2 }),
  })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Replace kitchen under-sink filter cartridge",
    status: "pending",
    priority: 2,
    urgency: 2,
    importance: 4,
    start_date: dublinToday(2),
    due_date: dublinToday(5),
    end_date: dublinToday(5),
    progress: 25,
    area_id: areaHome.id,
    project_id: projReset.id,
    assigned_to: haAgent.id,
    effort_minutes: 25,
    labels: ["home", "ha-automation"],
  }, { "X-Automation-Source": "ha", "X-Agent-Id": "ha.filter_counter" })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Upgrade Home Assistant Core to 2026.11",
    status: "backlog",
    priority: 2,
    urgency: 2,
    importance: 4,
    start_date: dublinToday(3),
    due_date: dublinToday(9),
    end_date: dublinToday(9),
    progress: 15,
    area_id: areaHomelab.id,
    project_id: projProxmox.id,
    assigned_to: conor.id,
    effort_minutes: 35,
    labels: ["homelab"],
  })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Put out green recycling bin",
    status: "pending",
    priority: 3,
    urgency: 4,
    importance: 2,
    due_date: dublinToday(2),
    area_id: areaFamily.id,
    project_id: projReset.id,
    assigned_to: aoife.id,
    effort_minutes: 5,
    labels: ["quick-win"],
  })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Clear leaves from side-passage gully",
    status: "backlog",
    priority: 3,
    urgency: 2,
    importance: 3,
    start_date: dublinToday(4),
    due_date: dublinToday(10),
    end_date: dublinToday(10),
    progress: 0,
    area_id: areaGarden.id,
    assigned_to: conor.id,
    effort_minutes: 40,
    labels: ["weekend"],
  })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Weekly grocery and pantry run",
    description: "Local market and bakery stop before dinner.",
    status: "pending",
    priority: 3,
    task_kind: "shopping_item",
    urgency: 3,
    importance: 3,
    due_date: dublinToday(1),
    area_id: areaFamily.id,
    project_id: projReset.id,
    assigned_to: aoife.id,
    effort_minutes: 40,
    labels: ["errands"],
    checklists: JSON.stringify([
      { text: "Oat milk and coffee beans", done: true },
      { text: "Dishwasher salt", done: false },
      { text: "Sourdough and apples", done: false },
    ]),
  })

  await apiCall(baseUrl, "/api/tasks", "POST", {
    title: "Organize spare Zigbee plugs in shed",
    status: "backlog",
    priority: 4,
    urgency: 1,
    importance: 2,
    start_date: dublinToday(7),
    due_date: dublinToday(13),
    end_date: dublinToday(13),
    progress: 0,
    area_id: areaGarden.id,
    assigned_to: conor.id,
    effort_minutes: 30,
    labels: ["homelab", "weekend"],
  })

  // Completed Today via pending -> PUT complete so gamification XP & streak update naturally
  const completedSeeds = [
    {
      title: "Empty dishwasher and reload",
      area_id: areaFamily.id,
      project_id: projReset.id,
      priority: 2,
      labels: ["ha-automation"],
      headers: { "X-Automation-Source": "ha", "X-Agent-Id": "ha.appliance_cycle" },
    },
    {
      title: "Drop kids' swimming gear in hall",
      area_id: areaFamily.id,
      priority: 3,
      labels: ["quick-win"],
      headers: {},
    },
    {
      title: "Verify off-site Borg backup checksum",
      area_id: areaHomelab.id,
      project_id: projProxmox.id,
      priority: 2,
      labels: ["homelab"],
      headers: {},
    },
  ]

  for (const seed of completedSeeds) {
    const created = await apiCall(
      baseUrl,
      "/api/tasks",
      "POST",
      {
        title: seed.title,
        status: "pending",
        priority: seed.priority,
        due_date: today,
        area_id: seed.area_id,
        ...(seed.project_id ? { project_id: seed.project_id } : {}),
        labels: seed.labels,
        urgency: 3,
        importance: 3,
      },
      seed.headers,
    )
    await apiCall(baseUrl, `/api/tasks/${created.id}`, "PUT", { status: "complete" })
  }

  return {
    today,
    leakSensorId: leakSensor.id,
    radiatorsId: radiators.id,
    carNctId: carNct.id,
    boilerTaskId: boilerTask.id,
  }
}

async function createCleanContext(browser, { width, height, deviceScaleFactor = 1, isMobile = false, hasTouch = false, reducedMotion = "reduce" }) {
  const today = dublinToday(0)
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    isMobile,
    hasTouch,
    reducedMotion,
    colorScheme: "dark",
    timezoneId: "Europe/Dublin",
    serviceWorkers: "block",
  })

  await context.addInitScript((todayStr) => {
    localStorage.setItem("meitheal-theme", "dark")
    localStorage.setItem("meitheal-pwa-dismissed", "permanent")
    localStorage.setItem("meitheal-evening-review-dismissed", todayStr)
    localStorage.setItem("meitheal-migration-dismissed", todayStr)
    localStorage.setItem(
      "meitheal-dismissed-helpers",
      JSON.stringify([
        "today-flow-explainer",
        "spaces-explainer",
        "pillars-explainer",
        "progress-routines-explainer",
        "progress-goals-explainer",
        "progress-achievements-explainer",
      ]),
    )
  }, today)

  return context
}

async function waitPageReady(page, { waitMotionSettle = false } = {}) {
  await page.waitForLoadState("domcontentloaded")
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      [...document.fonts]
        .filter(font => font.status === "loading")
        .map(font => font.loaded.catch(() => {})),
    )
  })
  await page.waitForFunction(() => {
    const dot = document.querySelector("#connection-status .status-dot")
    return !dot || dot.classList.contains("online")
  }, { timeout: 10_000 }).catch(() => {})

  await page.waitForFunction(() => {
    const badges = [...document.querySelectorAll("[data-project-task-count]")]
    return badges.length === 0 || badges.every(el => el.dataset.loaded === "true")
  }, { timeout: 10_000 }).catch(() => {})

  await page.waitForFunction(() => !document.documentElement.classList.contains("is-loading"), { timeout: 10_000 }).catch(() => {})

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    window.scrollTo({ top: 0, behavior: "instant" })
  })

  await page.evaluate(
    () =>
      new Promise((resolveFrame) => {
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
      }),
  )

  if (waitMotionSettle) {
    await page.waitForTimeout(350)
  }
}

function writeCompressedPng(
  rawBuffer,
  destPath,
  maxBytes = MAX_README_PNG_BYTES,
  targetWidth = 1440,
  targetHeight = 900,
) {
  const rawPath = `${destPath}.raw.png`
  writeFileSync(rawPath, rawBuffer)
  try {
    const scaleExpr = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=lanczos`
    // Pass 1: lossless 1x downscale so crisp vector typography & gradients remain unquantized when under cap
    execFileSync("ffmpeg", [
      "-y",
      "-i", rawPath,
      "-vf", scaleExpr,
      "-compression_level", "9",
      destPath,
    ], { stdio: "pipe" })

    let size = statSync(destPath).size
    if (size > maxBytes) {
      for (const colors of [256, 224, 160]) {
        execFileSync("ffmpeg", [
          "-y",
          "-i", rawPath,
          "-vf", `${scaleExpr},split[s0][s1];[s0]palettegen=max_colors=${colors}:stats_mode=single[p];[s1][p]paletteuse=dither=floyd_steinberg`,
          "-compression_level", "9",
          destPath,
        ], { stdio: "pipe" })
        size = statSync(destPath).size
        if (size <= maxBytes) break
      }
    }
    if (size > maxBytes) {
      throw new Error(`PNG ${destPath} is ${size} bytes, exceeding cap ${maxBytes}`)
    }
    return size
  } finally {
    if (existsSync(rawPath)) unlinkSync(rawPath)
  }
}

async function captureStaticStills(browser, baseUrl, outDir, seedIds) {
  const { today, radiatorsId } = seedIds
  const stillsDir = join(outDir, "stills")
  mkdirSync(stillsDir, { recursive: true })
  const results = []

  const desktopCtx = await createCleanContext(browser, {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  })

  const pageErrors = []
  try {
    const page = await desktopCtx.newPage()
    page.on("pageerror", err => pageErrors.push(err.message))

    // 1. Today (README still)
    console.log("[capture]   still: today.png")
    await page.goto(`${baseUrl}/today`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator("#daily-stats-container").waitFor({ state: "visible" })
    await page.locator("#today-due-list .tli").first().waitFor({ state: "visible" })
    const todayBuf = await page.screenshot({ type: "png" })
    const todayPath = join(stillsDir, "today.png")
    const todayBytes = writeCompressedPng(todayBuf, todayPath)
    results.push({ name: "today.png", path: todayPath, readme: true, width: 1440, height: 900, bytes: todayBytes })

    // 2. Dashboard (README still)
    console.log("[capture]   still: dashboard.png")
    await page.goto(`${baseUrl}/`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator("#dashboard-shell").waitFor({ state: "visible" })
    await page.locator("#dashboard-overview").waitFor({ state: "visible" })
    await page.locator("#my-open-list .task-item").first().waitFor({ state: "visible" })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }))
    const dashBuf = await page.screenshot({ type: "png" })
    const dashPath = join(stillsDir, "dashboard.png")
    const dashBytes = writeCompressedPng(dashBuf, dashPath)
    results.push({ name: "dashboard.png", path: dashPath, readme: true, width: 1440, height: 900, bytes: dashBytes })

    // 3. Kanban Board (README still)
    console.log("[capture]   still: kanban.png")
    await page.goto(`${baseUrl}/tasks?view=kanban#kanban`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator('[data-view-tabs][data-switcher-ready="true"]').waitFor({ state: "visible" })
    await page.locator('[data-task-view="kanban"]').waitFor({ state: "visible" })
    await page.locator('#kanban-shell[data-kanban-booted="true"]').waitFor({ state: "attached" })
    await page.locator("[data-kanban-loading]").waitFor({ state: "hidden" }).catch(() => {})
    await page.locator(".kanban-card").first().waitFor({ state: "visible" })
    const kanbanBuf = await page.screenshot({ type: "png" })
    const kanbanPath = join(stillsDir, "kanban.png")
    const kanbanBytes = writeCompressedPng(kanbanBuf, kanbanPath)
    results.push({ name: "kanban.png", path: kanbanPath, readme: true, width: 1440, height: 900, bytes: kanbanBytes })

    // 4. Table View (README still)
    console.log("[capture]   still: table.png")
    await page.goto(`${baseUrl}/tasks?view=table#table`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator('[data-task-view="table"]').waitFor({ state: "visible" })
    await page.locator("#task-table tbody tr.table-row").first().waitFor({ state: "visible" })
    const tableBuf = await page.screenshot({ type: "png" })
    const tablePath = join(stillsDir, "table.png")
    const tableBytes = writeCompressedPng(tableBuf, tablePath)
    results.push({ name: "table.png", path: tablePath, readme: true, width: 1440, height: 900, bytes: tableBytes })

    // 5. Calendar View with Today day drawer open (README still)
    console.log("[capture]   still: calendar.png")
    await page.goto(`${baseUrl}/tasks?view=calendar#calendar`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator('[data-task-view="calendar"] .calendar-grid .cal-cell.cal-has-tasks').first().waitFor({ state: "visible" })
    const todayCell = page.locator(`.cal-cell[data-date="${today}"]`)
    if (await todayCell.count()) {
      await todayCell.click()
      await page.locator('#day-drawer[aria-hidden="false"]').waitFor({ state: "visible" })
      await page.waitForTimeout(250)
    }
    const calBuf = await page.screenshot({ type: "png" })
    const calPath = join(stillsDir, "calendar.png")
    const calBytes = writeCompressedPng(calBuf, calPath)
    results.push({ name: "calendar.png", path: calPath, readme: true, width: 1440, height: 900, bytes: calBytes })

    // 6. Settings (Look & Feel, README still)
    console.log("[capture]   still: settings.png")
    await page.goto(`${baseUrl}/settings#look-and-feel-settings`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator("#settings-loading").waitFor({ state: "hidden" }).catch(() => {})
    await page.locator("#settings-panels:not([inert])").waitFor({ state: "visible" })
    await page.locator("#theme-select").waitFor({ state: "visible" })
    const settingsBuf = await page.screenshot({ type: "png" })
    const settingsPath = join(stillsDir, "settings.png")
    const settingsBytes = writeCompressedPng(settingsBuf, settingsPath)
    results.push({ name: "settings.png", path: settingsPath, readme: true, width: 1440, height: 900, bytes: settingsBytes })

    // 7. Campaign still: Timeline (Gantt)
    console.log("[capture]   still: timeline.png")
    await page.goto(`${baseUrl}/tasks?view=timeline#timeline`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator('[data-task-view="timeline"]').waitFor({ state: "visible" })
    await page.locator("#timeline-skeleton").waitFor({ state: "hidden" }).catch(() => {})
    await page.locator("#gantt-chart").waitFor({ state: "visible" })
    await page.locator(".gantt-bar").first().waitFor({ state: "visible" })
    const timelineBuf = await page.screenshot({ type: "png" })
    const timelinePath = join(stillsDir, "timeline.png")
    const timelineBytes = writeCompressedPng(timelineBuf, timelinePath, 400_000)
    results.push({ name: "timeline.png", path: timelinePath, readme: false, width: 1440, height: 900, bytes: timelineBytes })

    // 8. Campaign still: Task Detail Focus Mode
    console.log("[capture]   still: focus-mode.png")
    await page.goto(`${baseUrl}/tasks?view=kanban#kanban`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator('#kanban-shell[data-kanban-booted="true"]').waitFor({ state: "attached" })
    const targetOpenBtn = page.locator(`.kanban-card[data-id="${radiatorsId}"] .card-open-btn`)
    const openBtn = (await targetOpenBtn.count()) ? targetOpenBtn : page.locator(".kanban-card .card-open-btn").first()
    await openBtn.click()
    await page.locator("#task-detail-overlay.active").waitFor({ state: "visible" })
    await page.locator("#td-loaded-content:not(.hidden)").waitFor({ state: "visible" })
    await page.locator("#td-toggle-focus").click()
    await page.locator("#task-detail-overlay.active[data-focus-mode]").waitFor({ state: "visible" })
    await page.waitForTimeout(250)
    const focusBuf = await page.screenshot({ type: "png" })
    const focusPath = join(stillsDir, "focus-mode.png")
    const focusBytes = writeCompressedPng(focusBuf, focusPath, 400_000)
    results.push({ name: "focus-mode.png", path: focusPath, readme: false, width: 1440, height: 900, bytes: focusBytes })

    // 9. Campaign still: Eisenhower Matrix
    console.log("[capture]   still: eisenhower.png")
    await page.goto(`${baseUrl}/eisenhower`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator(".eisenhower__quadrant .tli").first().waitFor({ state: "visible" })
    const eisBuf = await page.screenshot({ type: "png" })
    const eisPath = join(stillsDir, "eisenhower.png")
    const eisBytes = writeCompressedPng(eisBuf, eisPath, 400_000)
    results.push({ name: "eisenhower.png", path: eisPath, readme: false, width: 1440, height: 900, bytes: eisBytes })
  } finally {
    await desktopCtx.close()
  }

  // 10. Campaign still: Mobile Today (390x844)
  const mobileCtx = await createCleanContext(browser, {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  })
  try {
    const page = await mobileCtx.newPage()
    page.on("pageerror", err => pageErrors.push(err.message))
    console.log("[capture]   still: mobile-today.png")
    await page.goto(`${baseUrl}/today`, { waitUntil: "load" })
    await waitPageReady(page)
    await page.locator("#daily-stats-container").waitFor({ state: "visible" })
    const mobBuf = await page.screenshot({ type: "png" })
    const mobPath = join(stillsDir, "mobile-today.png")
    const mobBytes = writeCompressedPng(mobBuf, mobPath, 300_000, 390, 844)
    results.push({ name: "mobile-today.png", path: mobPath, readme: false, width: 390, height: 844, bytes: mobBytes })
  } finally {
    await mobileCtx.close()
  }

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during still capture:\n${pageErrors.join("\n")}`)
  }
  return results
}

async function installHud(page) {
  await page.evaluate(() => {
    document.getElementById("meitheal-capture-hud")?.remove()
    const root = document.createElement("div")
    root.id = "meitheal-capture-hud"
    root.style.cssText = [
      "position:fixed",
      "inset:0",
      "pointer-events:none",
      "z-index:2147483647",
      "overflow:hidden",
      "font-family:'Geist Variable','Inter',sans-serif",
    ].join(";")

    const cursor = document.createElement("div")
    cursor.id = "mc-cursor"
    cursor.style.cssText = [
      "position:absolute",
      "left:-40px",
      "top:-40px",
      "width:18px",
      "height:18px",
      "border-radius:9999px",
      "border:2px solid #69E3B2",
      "background:rgba(241,239,232,0.94)",
      "box-shadow:0 2px 10px rgba(0,0,0,0.5)",
      "transform:translate(-50%,-50%)",
      "transition:left 280ms cubic-bezier(0.22,1,0.36,1), top 280ms cubic-bezier(0.22,1,0.36,1), transform 140ms ease",
      "opacity:0",
    ].join(";")

    const keyPill = document.createElement("div")
    keyPill.id = "mc-key-pill"
    keyPill.style.cssText = [
      "position:absolute",
      "right:22px",
      "bottom:80px",
      "padding:8px 14px",
      "border-radius:10px",
      "background:rgba(23,26,24,0.94)",
      "border:1px solid rgba(105,227,178,0.55)",
      "color:#F1EFE8",
      "font-family:'JetBrains Mono',monospace",
      "font-size:13px",
      "font-weight:600",
      "letter-spacing:0.02em",
      "box-shadow:0 10px 28px rgba(0,0,0,0.48)",
      "opacity:0",
      "transform:translateY(6px)",
      "transition:opacity 160ms ease, transform 160ms ease",
    ].join(";")

    const eventBanner = document.createElement("div")
    eventBanner.id = "mc-event-banner"
    eventBanner.style.cssText = [
      "position:absolute",
      "left:50%",
      "bottom:84px",
      "padding:9px 18px",
      "border-radius:9999px",
      "background:rgba(23,26,24,0.96)",
      "border:1px solid rgba(105,227,178,0.68)",
      "color:#ADF8D7",
      "font-size:13px",
      "font-weight:600",
      "box-shadow:0 10px 28px rgba(0,0,0,0.52)",
      "opacity:0",
      "transform:translate(-50%,8px)",
      "transition:opacity 180ms ease, transform 180ms ease",
    ].join(";")

    root.append(cursor, keyPill, eventBanner)
    document.body.appendChild(root)

    window.__mcHud = {
      moveTo(x, y) {
        cursor.style.opacity = "1"
        cursor.style.left = `${x}px`
        cursor.style.top = `${y}px`
      },
      pulse(x, y) {
        this.moveTo(x, y)
        cursor.style.transform = "translate(-50%,-50%) scale(0.78)"
        const ring = document.createElement("div")
        ring.style.cssText = [
          "position:absolute",
          `left:${x}px`,
          `top:${y}px`,
          "width:14px",
          "height:14px",
          "border-radius:9999px",
          "border:2px solid #69E3B2",
          "transform:translate(-50%,-50%) scale(1)",
          "opacity:0.9",
          "transition:transform 260ms ease-out, opacity 260ms ease-out",
        ].join(";")
        root.appendChild(ring)
        requestAnimationFrame(() => {
          ring.style.transform = "translate(-50%,-50%) scale(2.6)"
          ring.style.opacity = "0"
        })
        setTimeout(() => {
          cursor.style.transform = "translate(-50%,-50%) scale(1)"
        }, 120)
        setTimeout(() => ring.remove(), 300)
      },
      showKey(label, ms = 750) {
        keyPill.textContent = label
        keyPill.style.opacity = "1"
        keyPill.style.transform = "translateY(0)"
        clearTimeout(window.__mcKeyTimer)
        window.__mcKeyTimer = setTimeout(() => {
          keyPill.style.opacity = "0"
          keyPill.style.transform = "translateY(6px)"
        }, ms)
      },
      showBanner(label, ms = 2200) {
        eventBanner.textContent = label
        eventBanner.style.opacity = "1"
        eventBanner.style.transform = "translate(-50%,0)"
        clearTimeout(window.__mcBannerTimer)
        window.__mcBannerTimer = setTimeout(() => {
          eventBanner.style.opacity = "0"
          eventBanner.style.transform = "translate(-50%,8px)"
        }, ms)
      },
    }
  })
}

async function moveAndClick(page, locator, { pauseAfterMs = 260 } = {}) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Missing bounding box for click target")
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(([cx, cy]) => window.__mcHud?.moveTo(cx, cy), [x, y])
  await page.waitForTimeout(300)
  await page.evaluate(([cx, cy]) => window.__mcHud?.pulse(cx, cy), [x, y])
  await locator.click()
  if (pauseAfterMs > 0) await page.waitForTimeout(pauseAfterMs)
}

async function smoothDrag(page, sourceLocator, targetLocator) {
  const sBox = await sourceLocator.boundingBox()
  const tBox = await targetLocator.boundingBox()
  if (!sBox || !tBox) throw new Error("Missing bounding box for drag source or target")
  const sx = sBox.x + sBox.width / 2
  const sy = sBox.y + sBox.height / 2
  const tx = tBox.x + tBox.width / 2
  const ty = tBox.y + Math.min(180, tBox.height / 2)

  await page.evaluate(([cx, cy]) => window.__mcHud?.moveTo(cx, cy), [sx, sy])
  await page.waitForTimeout(260)
  await page.evaluate(([cx, cy]) => window.__mcHud?.pulse(cx, cy), [sx, sy])
  await sourceLocator.dragTo(targetLocator)
  await page.evaluate(([cx, cy]) => window.__mcHud?.moveTo(cx, cy), [tx, ty])
}

async function runCdpScene(context, name, workDir, scenarioFn) {
  const framesDir = join(workDir, `frames-${name}`)
  mkdirSync(framesDir, { recursive: true })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", err => pageErrors.push(err.message))

  const cdp = await context.newCDPSession(page)
  const recorded = []
  let active = false
  let frameIndex = 0
  const pendingWrites = []

  cdp.on("Page.screencastFrame", (event) => {
    const { data, metadata, sessionId } = event
    const p = (async () => {
      try {
        await cdp.send("Page.screencastFrameAck", { sessionId })
      } catch {
        /* ignore if closed */
      }
      if (!active) return
      const idx = ++frameIndex
      const fileName = `frame_${String(idx).padStart(4, "0")}.png`
      writeFileSync(join(framesDir, fileName), Buffer.from(data, "base64"))
      recorded.push({ fileName, ts: Number(metadata?.timestamp ?? Date.now() / 1000) })
    })()
    pendingWrites.push(p)
  })

  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 })

  try {
    await scenarioFn(page, {
      setCapturing(flag) {
        active = flag
      },
      async captureWait(ms) {
        await page.waitForTimeout(ms)
      },
    })
  } finally {
    active = false
    await cdp.send("Page.stopScreencast").catch(() => {})
    await Promise.allSettled(pendingWrites)
    await page.close()
  }

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page error in scene ${name}:\n${pageErrors.join("\n")}`)
  }
  if (recorded.length < 4) {
    throw new Error(`Scene ${name} captured too few frames (${recorded.length})`)
  }

  const lines = ["ffconcat version 1.0"]
  let totalSec = 0
  for (let i = 0; i < recorded.length; i++) {
    const cur = recorded[i]
    let dur = 0.08
    if (i < recorded.length - 1) {
      const delta = recorded[i + 1].ts - cur.ts
      dur = Math.min(1.5, Math.max(0.033, Number.isFinite(delta) ? delta : 0.066))
    } else {
      dur = 1.2
    }
    totalSec += dur
    lines.push(`file '${cur.fileName}'`)
    lines.push(`duration ${dur.toFixed(4)}`)
  }
  lines.push(`file '${recorded[recorded.length - 1].fileName}'`)
  const concatPath = join(framesDir, "frames.ffconcat")
  writeFileSync(concatPath, `${lines.join("\n")}\n`)

  return { framesDir, concatPath, frameCount: recorded.length, durationSec: totalSec }
}

function encodeLoopAssets(name, concatPath, loopsDir, workDir) {
  const mp4Path = join(loopsDir, `${name}.mp4`)
  const gifPath = join(loopsDir, `${name}.gif`)
  const palettePath = join(workDir, `palette-${name}.png`)

  execFileSync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest",
    "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "slow",
    "-tune", "stillimage",
    "-c:a", "aac",
    "-b:a", "64k",
    "-movflags", "+faststart",
    mp4Path,
  ], { stdio: "pipe" })

  const ladder = [
    { width: 1024, fps: 12, colors: 128, dither: "bayer:bayer_scale=5" },
    { width: 960, fps: 10, colors: 96, dither: "none" },
    { width: 840, fps: 10, colors: 64, dither: "none" },
  ]

  let gifBytes = 0
  let chosenProfile = null
  for (const step of ladder) {
    execFileSync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-vf", `fps=${step.fps},scale=${step.width}:-1:flags=lanczos,palettegen=max_colors=${step.colors}:stats_mode=diff:reserve_transparent=0`,
      palettePath,
    ], { stdio: "pipe" })

    execFileSync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-i", palettePath,
      "-lavfi", `fps=${step.fps},scale=${step.width}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=${step.dither}:diff_mode=rectangle`,
      "-loop", "0",
      gifPath,
    ], { stdio: "pipe" })

    gifBytes = statSync(gifPath).size
    chosenProfile = step
    if (gifBytes <= MAX_DISCOURSE_GIF_BYTES) break
  }

  if (gifBytes > MAX_DISCOURSE_GIF_BYTES) {
    throw new Error(`GIF ${gifPath} is ${gifBytes} bytes (> ${MAX_DISCOURSE_GIF_BYTES} Discourse cap) even at rung 3`)
  }

  const mp4Bytes = statSync(mp4Path).size
  const durationOut = Number(
    execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      mp4Path,
    ], { encoding: "utf8" }).trim(),
  )

  return {
    name,
    mp4Path,
    mp4Bytes,
    gifPath,
    gifBytes,
    gifProfile: chosenProfile,
    durationSec: Number.isFinite(durationOut) ? Number(durationOut.toFixed(2)) : 0,
  }
}

async function renderSlateCard(browser, baseUrl, outPngPath, { eyebrow, title, subtitle, footer }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  try {
    const page = await context.newPage()
    // Load root page first so self-hosted @fontsource font URLs work directly from local origin
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
    await page.setContent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              width: 1280px; height: 720px;
              background: radial-gradient(circle at 18% 18%, rgba(20,108,78,0.24), transparent 52%),
                          radial-gradient(circle at 82% 84%, rgba(105,227,178,0.14), transparent 46%),
                          #101210;
              color: #F1EFE8;
              font-family: 'Geist Variable', 'Inter Variable', 'Noto Sans', sans-serif;
              display: flex; align-items: center; justify-content: center; padding: 80px;
            }
            .card {
              width: 100%; max-width: 980px; padding: 52px 60px;
              background: rgba(23, 26, 24, 0.92);
              border: 1px solid #344039;
              border-radius: 20px;
              box-shadow: 0 28px 64px rgba(0, 0, 0, 0.6);
            }
            .brand-row {
              display: flex; align-items: center; gap: 16px; margin-bottom: 22px;
            }
            .brand-mark {
              width: 46px; height: 46px; border-radius: 12px;
              background: #171A18; border: 1px solid #344039;
              display: inline-flex; align-items: center; justify-content: center;
              font-weight: 700; font-size: 24px; letter-spacing: -0.04em; color: #F1EFE8;
            }
            .brand-mark .dot { color: #69E3B2; }
            .eyebrow {
              font-family: 'JetBrains Mono', monospace;
              font-size: 13px; font-weight: 600; letter-spacing: 0.06em;
              text-transform: uppercase; color: #69E3B2;
            }
            h1 {
              font-size: 46px; line-height: 1.14; font-weight: 700;
              letter-spacing: -0.025em; color: #F1EFE8; margin-bottom: 18px;
            }
            p {
              font-size: 21px; line-height: 1.48; color: #C2CBC3; margin-bottom: 28px;
            }
            .footer {
              font-family: 'JetBrains Mono', monospace;
              font-size: 14px; color: #8C9A91; padding-top: 20px;
              border-top: 1px solid #344039;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="brand-row">
              <div class="brand-mark">m<span class="dot">.</span></div>
              <div class="eyebrow">${escapeHtml(eyebrow)}</div>
            </div>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(subtitle)}</p>
            <div class="footer">${escapeHtml(footer)}</div>
          </div>
        </body>
      </html>
    `)
    await page.evaluate(async () => { await document.fonts.ready })
    await page.screenshot({ path: outPngPath, type: "png" })
  } finally {
    await context.close()
  }
}

function buildCaptionedSegment(inputMp4, captionText, fontPath, outputMp4) {
  const escapedCaption = escapeFfmpegDrawtext(captionText)
  const escapedFont = escapeFfmpegDrawtext(fontPath)
  const vf = [
    "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#101210",
    "drawbox=x=0:y=656:w=1280:h=64:color=#101210@0.92:t=fill",
    "drawbox=x=0:y=656:w=1280:h=1:color=#69E3B2@0.45:t=fill",
    `drawtext=fontfile='${escapedFont}':text='${escapedCaption}':fontcolor=#F1EFE8:fontsize=22:x=(w-text_w)/2:y=676`,
  ].join(",")
  execFileSync("ffmpeg", [
    "-y",
    "-i", inputMp4,
    "-vf", vf,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "slow",
    "-c:a", "aac",
    "-b:a", "64k",
    outputMp4,
  ], { stdio: "pipe" })
}

function buildStillVideoSegment(pngPath, durationSec, outputMp4) {
  execFileSync("ffmpeg", [
    "-y",
    "-loop", "1",
    "-t", String(durationSec),
    "-i", pngPath,
    "-f", "lavfi",
    "-t", String(durationSec),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest",
    "-vf", "fps=30,scale=1280:720,format=yuv420p",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "slow",
    "-c:a", "aac",
    "-b:a", "64k",
    outputMp4,
  ], { stdio: "pipe" })
}

async function buildRedditReel(browser, baseUrl, loops, outDir, workDir) {
  const redditDir = join(outDir, "reddit")
  mkdirSync(redditDir, { recursive: true })
  const fontPath = resolveFontFile()

  const introPng = join(workDir, "intro.png")
  const outroPng = join(workDir, "outro.png")
  await renderSlateCard(browser, baseUrl, introPng, {
    eyebrow: "MEITHEAL (/meh·hal/) · HOME ASSISTANT APP",
    title: "Keep track of the work your home needs.",
    subtitle: "Simple enough for family chores on a kitchen tablet. Wired directly to Home Assistant automations, SQLite, and Assist.",
    footer: "Runs in HA Ingress · Local SQLite · Assist & PWA",
  })
  await renderSlateCard(browser, baseUrl, outroPng, {
    eyebrow: "OPEN SOURCE (AGPL-3.0) · SEEKING TESTERS & CO-MAINTAINERS",
    title: "Try Meitheal in Home Assistant",
    subtitle: "Free & open source under AGPL-3.0, with Apache 2.0 Home Assistant & Node-RED integrations.",
    footer: "meitheal.io · github.com/ryan-winkler/meitheal · github.com/ryan-winkler/meitheal-ha-addon",
  })

  const introMp4 = join(workDir, "seg-intro.mp4")
  const outroMp4 = join(workDir, "seg-outro.mp4")
  buildStillVideoSegment(introPng, 2.5, introMp4)
  buildStillVideoSegment(outroPng, 2.8, outroMp4)

  const captions = {
    "01-hero-iceberg": "Today view: natural-language quick add, instant check-off & Kanban board",
    "02-multiview-kanban": "One household list across Kanban, Table, Calendar & Timeline Gantt views",
    "03-command-search": "Instant Search Hub (Ctrl+K) to Task Detail Focus Mode with RICE scoring",
    "04-home-assistant-bridge": "Home Assistant automation trigger -> SQLite task -> Eisenhower Matrix",
  }

  const reelLoops = loops.slice(0, 4)
  const segmentPaths = [introMp4]
  for (const loop of reelLoops) {
    const segOut = join(workDir, `seg-${loop.name}.mp4`)
    buildCaptionedSegment(loop.mp4Path, captions[loop.name] ?? loop.name, fontPath, segOut)
    segmentPaths.push(segOut)
  }
  segmentPaths.push(outroMp4)

  const listPath = join(workDir, "reel-segments.txt")
  writeFileSync(listPath, `${segmentPaths.map(p => `file '${String(p).replace(/'/g, "'\\''")}'`).join("\n")}\n`)

  const reelPath = join(redditDir, "meitheal-launch-reel.mp4")
  execFileSync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "slow",
    "-c:a", "aac",
    "-b:a", "64k",
    "-movflags", "+faststart",
    reelPath,
  ], { stdio: "pipe" })

  const durationSec = Number(
    execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      reelPath,
    ], { encoding: "utf8" }).trim(),
  )

  return {
    name: "meitheal-launch-reel.mp4",
    path: reelPath,
    bytes: statSync(reelPath).size,
    durationSec: Number.isFinite(durationSec) ? Number(durationSec.toFixed(2)) : 0,
  }
}

async function navigateViaClick(page, ctl, locator, readyFn) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Missing bounding box for navigation target")
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(([cx, cy]) => window.__mcHud?.moveTo(cx, cy), [x, y])
  await ctl.captureWait(240)
  await page.evaluate(([cx, cy]) => window.__mcHud?.pulse(cx, cy), [x, y])
  ctl.setCapturing(false)
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    locator.click(),
  ])
  await waitPageReady(page, { waitMotionSettle: true })
  if (readyFn) await readyFn()
  await installHud(page)
  ctl.setCapturing(true)
}

async function captureLoops(browser, dbPath, restartServerFn, baseUrlRef, outDir, workDir, seedIds) {
  const loopsDir = join(outDir, "loops")
  mkdirSync(loopsDir, { recursive: true })
  const loopResults = []

  // Scene 1: Hero Iceberg (Today NLP Quick Add + Complete task + Jump to Kanban)
  console.log("[capture]   loop: 01-hero-iceberg")
  {
    const ctx = await createCleanContext(browser, {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    })
    try {
      const scene = await runCdpScene(ctx, "01-hero-iceberg", workDir, async (page, ctl) => {
        await page.goto(`${baseUrlRef.url}/today`, { waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await installHud(page)
        ctl.setCapturing(true)
        await ctl.captureWait(650)

        const input = page.locator("#quick-add-input")
        await moveAndClick(page, input, { pauseAfterMs: 180 })
        await input.type("Replace HVAC filter next friday ! #home", { delay: 32 })
        await page.locator("#quick-add-feedback").waitFor({ state: "visible" })
        await ctl.captureWait(750)

        await page.evaluate(() => window.__mcHud?.showKey("Enter"))
        await ctl.captureWait(220)
        ctl.setCapturing(false)
        await Promise.all([
          page.waitForNavigation({ waitUntil: "load" }).catch(() => {}),
          input.press("Enter"),
        ])
        await waitPageReady(page, { waitMotionSettle: true })
        await installHud(page)
        ctl.setCapturing(true)
        await ctl.captureWait(450)

        const nctCheckbox = page.locator(`.tli[data-id="${seedIds.carNctId}"] .tli__checkbox`)
        if (await nctCheckbox.count()) {
          await moveAndClick(page, nctCheckbox, { pauseAfterMs: 750 })
        }

        const kanbanNav = page.locator('a.nav-link[data-page="tasks"]').first()
        await navigateViaClick(page, ctl, kanbanNav, async () => {
          await page.locator('[data-task-view="kanban"]').waitFor({ state: "visible" })
          await page.locator('#kanban-shell[data-kanban-booted="true"]').waitFor({ state: "attached" })
          await page.locator("[data-kanban-loading]").waitFor({ state: "hidden" }).catch(() => {})
          await page.locator(".kanban-card").first().waitFor({ state: "visible" })
        })
        await ctl.captureWait(1100)
      })
      loopResults.push(encodeLoopAssets("01-hero-iceberg", scene.concatPath, loopsDir, workDir))
    } finally {
      await ctx.close()
    }
  }

  // Scene 2: Multiview Kanban -> Drag card -> Table -> Calendar + Day Drawer -> Timeline (Gantt)
  console.log("[capture]   loop: 02-multiview-kanban")
  {
    const ctx = await createCleanContext(browser, {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    })
    try {
      const scene = await runCdpScene(ctx, "02-multiview-kanban", workDir, async (page, ctl) => {
        await page.goto(`${baseUrlRef.url}/tasks?view=kanban#kanban`, { waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await page.locator('[data-view-tabs][data-switcher-ready="true"]').waitFor({ state: "visible" })
        await page.locator('[data-task-view="kanban"]').waitFor({ state: "visible" })
        await page.locator('#kanban-shell[data-kanban-booted="true"]').waitFor({ state: "attached" })
        await installHud(page)
        ctl.setCapturing(true)
        await ctl.captureWait(600)

        const pendingCard = page.locator('.kanban-column[data-status="pending"] .kanban-card').first()
        const activeLane = page.locator('.kanban-column[data-status="active"]')
        if (await pendingCard.count()) {
          await smoothDrag(page, pendingCard, activeLane)
          await page.locator("[data-kanban-loading]").waitFor({ state: "hidden" }).catch(() => {})
          await ctl.captureWait(750)
        }

        // Switch to Table (full SSR route transition on ryan/dev)
        await navigateViaClick(page, ctl, page.locator('[data-view-tab="table"]'), async () => {
          await page.locator('[data-task-view="table"]').waitFor({ state: "visible" })
          await page.locator("#task-table tbody tr.table-row").first().waitFor({ state: "visible" })
        })
        await ctl.captureWait(950)

        // Switch to Calendar + open Today drawer
        await navigateViaClick(page, ctl, page.locator('[data-view-tab="calendar"]'), async () => {
          await page.locator('[data-task-view="calendar"]').waitFor({ state: "visible" })
          await page.locator('[data-task-view="calendar"] .cal-cell.cal-has-tasks').first().waitFor({ state: "visible" })
        })
        await ctl.captureWait(350)
        const todayCell = page.locator(`.cal-cell[data-date="${seedIds.today}"]`)
        if (await todayCell.count()) {
          await moveAndClick(page, todayCell, { pauseAfterMs: 350 })
          await page.locator('#day-drawer[aria-hidden="false"]').waitFor({ state: "visible" })
          await ctl.captureWait(850)
          const closeBtn = page.locator("#day-drawer-close")
          await moveAndClick(page, closeBtn, { pauseAfterMs: 250 })
        }

        // Switch to Timeline (Gantt)
        await navigateViaClick(page, ctl, page.locator('[data-view-tab="timeline"]'), async () => {
          await page.locator('[data-task-view="timeline"]').waitFor({ state: "visible" })
          await page.locator("#timeline-skeleton").waitFor({ state: "hidden" }).catch(() => {})
          await page.locator("#gantt-chart").waitFor({ state: "visible" })
          await page.locator(".gantt-bar").first().waitFor({ state: "visible" })
        })
        await ctl.captureWait(1200)
      })
      loopResults.push(encodeLoopAssets("02-multiview-kanban", scene.concatPath, loopsDir, workDir))
    } finally {
      await ctx.close()
    }
  }

  // Restart server cleanly between loop batches to keep rateLimitMap well below 300/min
  await restartServerFn()

  // Scene 3: Command Search Hub (Ctrl+K -> search Proxmox -> Actions scope -> Radiators -> Focus Mode)
  console.log("[capture]   loop: 03-command-search")
  {
    const ctx = await createCleanContext(browser, {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    })
    try {
      const scene = await runCdpScene(ctx, "03-command-search", workDir, async (page, ctl) => {
        await page.goto(`${baseUrlRef.url}/today`, { waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await page.locator('#search-hub-overlay[data-search-controller="ready"]').waitFor({ state: "attached" })
        await installHud(page)
        ctl.setCapturing(true)
        await ctl.captureWait(550)

        await page.evaluate(() => window.__mcHud?.showKey("Ctrl + K"))
        await page.keyboard.press("Control+k")
        await page.locator("#search-hub-overlay:not(.hidden)").waitFor({ state: "visible" })
        const searchInput = page.locator("#search-hub-input")
        await ctl.captureWait(350)

        await searchInput.type("Proxmox", { delay: 45 })
        await page.waitForTimeout(220)
        await page.locator(".search-hub-item").first().waitFor({ state: "visible" })
        await ctl.captureWait(850)

        await moveAndClick(page, page.locator('.search-hub-scope[data-scope="actions"]'), { pauseAfterMs: 800 })
        await moveAndClick(page, page.locator('.search-hub-scope[data-scope="all"]'), { pauseAfterMs: 200 })

        await searchInput.fill("")
        await searchInput.type("radiators", { delay: 45 })
        await page.waitForTimeout(220)
        const radiatorHit = page.locator(".search-hub-item").first()
        await radiatorHit.waitFor({ state: "visible" })
        await ctl.captureWait(450)

        await moveAndClick(page, radiatorHit, { pauseAfterMs: 200 })
        await page.locator("#task-detail-overlay.active").waitFor({ state: "visible" })
        await page.locator("#td-loaded-content:not(.hidden)").waitFor({ state: "visible" })
        await ctl.captureWait(650)

        // Expand into Focus Mode showing full RICE & Auto-score with Assist view
        await moveAndClick(page, page.locator("#td-toggle-focus"), { pauseAfterMs: 250 })
        await page.locator("#task-detail-overlay.active[data-focus-mode]").waitFor({ state: "visible" })
        await ctl.captureWait(1100)
      })
      loopResults.push(encodeLoopAssets("03-command-search", scene.concatPath, loopsDir, workDir))
    } finally {
      await ctx.close()
    }
  }

  // Scene 4: Home Assistant Automation Bridge -> Task appears -> Eisenhower Drag
  console.log("[capture]   loop: 04-home-assistant-bridge")
  {
    const ctx = await createCleanContext(browser, {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    })
    try {
      const scene = await runCdpScene(ctx, "04-home-assistant-bridge", workDir, async (page, ctl) => {
        await page.goto(`${baseUrlRef.url}/tasks?view=kanban#kanban`, { waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await page.locator('#kanban-shell[data-kanban-booted="true"]').waitFor({ state: "attached" })
        await installHud(page)
        ctl.setCapturing(true)
        await ctl.captureWait(600)

        await page.evaluate(() =>
          window.__mcHud?.showBanner("Home Assistant Automation -> meitheal.create_task"),
        )
        await ctl.captureWait(650)

        // Real API call with X-Automation-Source: ha -> persisted & promoted card
        const haTask = await apiCall(
          baseUrlRef.url,
          "/api/tasks",
          "POST",
          {
            title: "Empty washing machine (cycle finished)",
            description: "Triggered by sensor.washer_power dropping below 4W for 5 minutes.",
            status: "pending",
            priority: 2,
            urgency: 4,
            importance: 4,
            due_date: seedIds.today,
            color: "#146C4E",
            labels: ["ha-automation", "home"],
          },
          { "X-Automation-Source": "ha", "X-Agent-Id": "ha.appliance_cycle" },
        )
        await apiCall(baseUrlRef.url, `/api/tasks/${haTask.id}`, "PUT", { is_promoted: true })

        ctl.setCapturing(false)
        await page.reload({ waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await page.locator('#kanban-shell[data-kanban-booted="true"]').waitFor({ state: "attached" })
        await page.locator(`.kanban-card[data-id="${haTask.id}"]`).waitFor({ state: "visible" })
        await installHud(page)
        await page.evaluate(() =>
          window.__mcHud?.showBanner("Persisted in SQLite with source: ha + Promoted badge"),
        )
        ctl.setCapturing(true)
        await ctl.captureWait(1100)

        ctl.setCapturing(false)
        await page.goto(`${baseUrlRef.url}/eisenhower`, { waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await page.locator(".eisenhower__quadrant .tli").first().waitFor({ state: "visible" })
        await installHud(page)
        ctl.setCapturing(true)
        await ctl.captureWait(550)

        const q2Item = page.locator('[data-drop-zone="schedule"] .tli').first()
        const q1Zone = page.locator('[data-drop-zone="do-first"]')
        if (await q2Item.count()) {
          await smoothDrag(page, q2Item, q1Zone)
          await ctl.captureWait(1100)
        }
      })
      loopResults.push(encodeLoopAssets("04-home-assistant-bridge", scene.concatPath, loopsDir, workDir))
    } finally {
      await ctx.close()
    }
  }

  // Restart server cleanly before Scene 5 to keep rateLimitMap well below 300/min
  await restartServerFn()

  // Scene 5: Look & Feel Themes (Emerald Isle -> Knight Rider + Pink Accent -> Light -> Reset Emerald Isle)
  console.log("[capture]   loop: 05-look-and-feel-themes")
  {
    const ctx = await createCleanContext(browser, {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    })
    try {
      const scene = await runCdpScene(ctx, "05-look-and-feel-themes", workDir, async (page, ctl) => {
        await page.goto(`${baseUrlRef.url}/settings#look-and-feel-settings`, { waitUntil: "load" })
        await waitPageReady(page, { waitMotionSettle: true })
        await page.locator("#settings-loading").waitFor({ state: "hidden" }).catch(() => {})
        await page.locator("#settings-panels:not([inert])").waitFor({ state: "visible" })
        const themeSelect = page.locator("#theme-select")
        await themeSelect.waitFor({ state: "visible" })
        await installHud(page)
        await page.evaluate(() => window.__mcHud?.showBanner("Look & Feel: Emerald Isle (default)"))
        ctl.setCapturing(true)
        await ctl.captureWait(700)

        // Helper for live theme select switch
        const selectTheme = async (value, bannerText) => {
          const box = await themeSelect.boundingBox()
          if (box) {
            await page.evaluate(([cx, cy]) => window.__mcHud?.moveTo(cx, cy), [box.x + box.width / 2, box.y + box.height / 2])
            await ctl.captureWait(220)
            await page.evaluate(([cx, cy]) => window.__mcHud?.pulse(cx, cy), [box.x + box.width / 2, box.y + box.height / 2])
          }
          await themeSelect.selectOption(value)
          await page.waitForFunction(
            target => document.documentElement.dataset.theme === target && !document.getElementById("theme-select")?.disabled,
            value,
            { timeout: 8_000 },
          )
          await page.evaluate(txt => window.__mcHud?.showBanner(txt), bannerText)
          await ctl.captureWait(750)
        }

        await selectTheme("knight-rider", "Theme: Knight Rider")

        const pinkSwatch = page.locator('.accent-swatch[data-color="#ec4899"]')
        await moveAndClick(page, pinkSwatch, { pauseAfterMs: 180 })
        await page.evaluate(() => window.__mcHud?.showBanner("Accent: Pink (#ec4899) applied immediately"))
        await ctl.captureWait(750)

        await selectTheme("light", "Theme: Light (Warm Paper)")

        await selectTheme("dark", "Reset to Emerald Isle + Living Mint")
        await moveAndClick(page, page.locator("#accent-reset"), { pauseAfterMs: 750 })
      })
      loopResults.push(encodeLoopAssets("05-look-and-feel-themes", scene.concatPath, loopsDir, workDir))
    } finally {
      await ctx.close()
    }
  }

  return loopResults
}

function syncReadmeScreenshots(stills) {
  mkdirSync(DOCS_SCREENSHOTS_DIR, { recursive: true })
  const staleFiles = ["tasks.png"]
  for (const stale of staleFiles) {
    const p = join(DOCS_SCREENSHOTS_DIR, stale)
    if (existsSync(p)) unlinkSync(p)
  }
  for (const still of stills) {
    if (!still.readme) continue
    const target = join(DOCS_SCREENSHOTS_DIR, still.name)
    copyFileSync(still.path, target)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  assertTooling()
  mkdirSync(options.outDir, { recursive: true })

  const workDir = mkdtempSync(join(tmpdir(), "meitheal-marketing-"))
  const dbPath = join(workDir, "meitheal.db")
  if (!options.baseUrl) {
    console.log("[capture] Migrating isolated SQLite fixture database...")
    migrateDatabase(dbPath)
  }
  const port = options.baseUrl ? 0 : await getFreePort()
  let server = options.baseUrl ? null : await startServer(dbPath, port)
  const baseUrlRef = { url: options.baseUrl ?? server.baseUrl }

  const restartServerFn = async () => {
    if (!server) return
    await server.stop()
    server = await startServer(dbPath, port)
    baseUrlRef.url = server.baseUrl
  }

  let browser
  try {
    console.log(`[capture] Seeding deterministic household fixture against ${baseUrlRef.url} ...`)
    const seedIds = await seedHouseholdFixture(baseUrlRef.url)

    if (server) {
      console.log("[capture] Restarting production server to reset rate-limit bucket & warm cache...")
      await restartServerFn()
    }

    browser = await chromium.launch({ headless: true })

    console.log("[capture] Capturing static screenshots...")
    const stills = await captureStaticStills(browser, baseUrlRef.url, options.outDir, seedIds)

    if (options.updateReadme) {
      syncReadmeScreenshots(stills)
      console.log(`[capture] Synced ${stills.filter(s => s.readme).length} README screenshots to docs/screenshots/`)
    }

    let loops = []
    let redditReel = null
    if (!options.stillsOnly) {
      if (server) await restartServerFn()
      console.log("[capture] Capturing 5 CDP lossless feature loops + encoding MP4 & Discourse GIFs...")
      loops = await captureLoops(browser, dbPath, restartServerFn, baseUrlRef, options.outDir, workDir, seedIds)

      console.log("[capture] Stitching captioned Reddit launch reel...")
      redditReel = await buildRedditReel(browser, baseUrlRef.url, loops, options.outDir, workDir)
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      serverUrl: baseUrlRef.url,
      stills,
      loops,
      redditReel,
    }
    writeFileSync(join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`[capture] Done. Manifest written to ${join(options.outDir, "manifest.json")}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) await server.stop().catch(() => {})
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[capture] Fatal error:", err)
    process.exit(1)
  })
}
