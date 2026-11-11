import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { test, expect } from "@playwright/test"

const repoRoot = path.join(process.cwd(), "..")
const COMPONENT_DIR = path.join(
  repoRoot,
  "integrations/home-assistant/custom_components/meitheal",
)

function readJSON(filename: string) {
  return JSON.parse(fs.readFileSync(path.join(COMPONENT_DIR, filename), "utf-8"))
}

function fileExists(filename: string) {
  return fs.existsSync(path.join(COMPONENT_DIR, filename))
}

function readPython(filename: string) {
  return fs.readFileSync(path.join(COMPONENT_DIR, filename), "utf-8")
}

test.describe("Home Assistant setup contract", () => {
  test("config-flow: manifest declares config_flow", () => {
    const manifest = readJSON("manifest.json")
    expect(manifest.config_flow).toBe(true)
  })

  test("unique-config-entry: manifest declares single_config_entry", () => {
    const manifest = readJSON("manifest.json")
    expect(manifest.single_config_entry).toBe(true)
  })

  test("has-entity-name: all entities set _attr_has_entity_name", () => {
    for (const file of ["sensor.py", "todo.py"]) {
      const src = readPython(file)
      expect(src).toContain("_attr_has_entity_name = True")
    }
  })

  test("entity-unique-id: all entities set _attr_unique_id", () => {
    for (const file of ["sensor.py", "todo.py"]) {
      const src = readPython(file)
      expect(src).toContain("_attr_unique_id")
    }
  })

  test("runtime-data: no Python file uses hass.data[DOMAIN] for coordinator lookup", () => {
    // This catches the bug where intents.py and llm_api.py were silently broken
    for (const file of ["__init__.py", "sensor.py", "todo.py", "diagnostics.py", "intents.py", "llm_api.py"]) {
      const src = readPython(file)
      expect(src).not.toContain("hass.data[DOMAIN]")
      expect(src).not.toContain("hass.data.get(DOMAIN")
    }
  })

  test("action-setup: services registered in async_setup_entry", () => {
    const init = readPython("__init__.py")
    expect(init).toContain("hass.services.async_register")
  })

  test("test-before-setup: uses async_config_entry_first_refresh", () => {
    const init = readPython("__init__.py")
    expect(init).toContain("async_config_entry_first_refresh")
  })

  test("common-modules: helpers.py exists with shared device_info", () => {
    expect(fileExists("helpers.py")).toBe(true)
    const helpers = readPython("helpers.py")
    expect(helpers).toContain("def device_info")
    expect(helpers).toContain("PARALLEL_UPDATES")
  })

  test("dependency-transparency: manifest has requirements array", () => {
    const manifest = readJSON("manifest.json")
    expect(Array.isArray(manifest.requirements)).toBe(true)
  })

  test("config-flow data_description: user step has data_description", () => {
    const strings = readJSON("translations/en.json")
    expect(strings.config.step.user.data_description).toBeDefined()
  })
})

test.describe("Home Assistant lifecycle contract", () => {
  test("action-exceptions: uses translation_key in HomeAssistantError", () => {
    const init = readPython("__init__.py")
    expect(init).toContain("translation_key=")
    expect(init).toContain("translation_domain=")
  })

  test("config-entry-unloading: async_unload_entry implemented", () => {
    const init = readPython("__init__.py")
    expect(init).toContain("async_unload_entry")
    expect(init).toContain("async_unload_platforms")
  })

  test("parallel-updates: PARALLEL_UPDATES defined in platform modules", () => {
    for (const file of ["sensor.py", "todo.py"]) {
      const src = readPython(file)
      expect(src).toContain("PARALLEL_UPDATES")
    }
  })

  test("integration-owner: manifest has codeowners", () => {
    const manifest = readJSON("manifest.json")
    expect(manifest.codeowners.length).toBeGreaterThan(0)
  })

  test("log-when-unavailable: coordinator logs availability transitions", () => {
    const coord = readPython("coordinator.py")
    expect(coord).toContain("_was_available")
    expect(coord).toContain("is available again")
    expect(coord).toContain("Cannot reach Meitheal at")
  })
})

test.describe("Home Assistant entities and discovery contract", () => {
  test("devices: device registered in __init__.py", () => {
    const init = readPython("__init__.py")
    expect(init).toContain("async_get_or_create")
    expect(init).toContain("meitheal_hub")
  })

  test("diagnostics: diagnostics.py exists", () => {
    expect(fileExists("diagnostics.py")).toBe(true)
    const diag = readPython("diagnostics.py")
    expect(diag).toContain("async_get_config_entry_diagnostics")
  })

  test("Supervisor discovery stays optional on standalone Core", () => {
    const manifest = readJSON("manifest.json")
    expect(manifest.after_dependencies).toContain("hassio")
    expect(manifest.dependencies ?? []).not.toContain("hassio")
  })

  test("entity-category: sensors use EntityCategory", () => {
    const sensor = readPython("sensor.py")
    expect(sensor).toContain("EntityCategory.DIAGNOSTIC")
  })

  test("entity-disabled-by-default: total_tasks disabled by default", () => {
    const sensor = readPython("sensor.py")
    expect(sensor).toContain("entity_registry_enabled_default = False")
  })

  test("entity-translations: translations/en.json has entity translations", () => {
    const strings = readJSON("translations/en.json")
    expect(strings.entity.sensor.active_tasks.name).toBeDefined()
    expect(strings.entity.todo.task_list.name).toBeDefined()
  })

  test("exception-translations: translations/en.json has exception translations", () => {
    const strings = readJSON("translations/en.json")
    expect(strings.exceptions.create_failed.message).toBeDefined()
    expect(strings.exceptions.addon_unavailable.message).toBeDefined()
  })

  test("icon-translations: icons.json exists", () => {
    expect(fileExists("icons.json")).toBe(true)
    const icons = readJSON("icons.json")
    expect(icons.entity.sensor.active_tasks.default).toBeDefined()
    expect(icons.services.create_task.service).toBeDefined()
  })

  test("reconfiguration-flow: config_flow has async_step_reconfigure", () => {
    const flow = readPython("config_flow.py")
    expect(flow).toContain("async_step_reconfigure")
  })

  test("repair-issues: repairs.py exists with issue creation", () => {
    expect(fileExists("repairs.py")).toBe(true)
    const repairs = readPython("repairs.py")
    expect(repairs).toContain("async_create_issue")
    expect(repairs).toContain("async_delete_issue")
  })

  test("reconfiguration strings: translations/en.json has reconfigure step", () => {
    const strings = readJSON("translations/en.json")
    expect(strings.config.step.reconfigure).toBeDefined()
    expect(strings.config.step.reconfigure.data.host).toBeDefined()
    expect(strings.config.step.reauth_confirm.data.api_token).toBeDefined()
  })

  test("repair issue strings: translations/en.json has issues section", () => {
    const strings = readJSON("translations/en.json")
    expect(strings.issues.addon_unreachable.title).toBeDefined()
  })
})

test.describe("Home Assistant runtime package contract", () => {
  test("async-dependency: uses aiohttp (async)", () => {
    const api = readPython("api.py")
    expect(api).toContain("import aiohttp")
  })

  test("entry creates a Home Assistant-managed HTTP session", () => {
    const init = readPython("__init__.py")
    expect(init).toContain("async_create_clientsession")
  })

  test("strict-typing: py.typed marker exists", () => {
    expect(fileExists("py.typed")).toBe(true)
  })

  test("Marketplace metadata matches the runtime package", () => {
    const manifest = readJSON("manifest.json")
    const metadata = readJSON("../../hacs.json")
    expect(manifest.domain).toBe("meitheal")
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.quality_scale).toBeUndefined()
    expect(manifest.categories).toContain("productivity_information.calendars_todos")
    expect(metadata.homeassistant).toBe("2026.10.4")
    expect(fileExists("brand/icon.png")).toBe(true)
  })
})


test("both Core CI profiles build this checkout before required App/native protocol tests", () => {
  const { parse } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("yaml")
  const workflow = parse(fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"))
  type Step = { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
  const core = workflow.jobs["ha-core"] as { steps: Step[]; strategy: { matrix: { include: unknown[] } } }
  expect(core.strategy.matrix.include).toEqual([
    { core: "2026.10.4", requirements: "requirements-test-2026.10.txt" },
    { core: "2026.11.1", requirements: "requirements-test.txt" },
  ])
  const pnpm = core.steps.findIndex(step => step.uses === "pnpm/action-setup@v6" && step.with?.version === "10.34.9")
  const node = core.steps.findIndex(step => step.uses === "actions/setup-node@v7" && String(step.with?.["node-version"]) === "22")
  const install = core.steps.findIndex(step => step.run?.trim() === "pnpm install --frozen-lockfile")
  const build = core.steps.findIndex(step => step.run?.trim() === "pnpm --filter @meitheal/web build")
  const native = core.steps.findIndex(step => step.run?.includes("python -m pytest"))
  expect(pnpm).toBeGreaterThan(-1)
  expect(node).toBeGreaterThan(pnpm)
  expect(install).toBeGreaterThan(node)
  expect(build).toBeGreaterThan(install)
  expect(native).toBeGreaterThan(build)
  expect(core.steps[native]!.env?.MEITHEAL_REQUIRE_APP_PROTOCOL).toBe("1")
})
