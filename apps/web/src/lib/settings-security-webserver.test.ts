import test from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { canManageSystemSettings, isSecretSetting, isSystemSetting } from "./settings-security"
import {
  getGroupedSettingsSections,
  LEGACY_SETTINGS_SECTION_ALIASES,
  resolveSettingsSectionId,
  searchSettingsRegistry,
  SETTINGS_DOMAIN_GROUPS,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
} from "./settings-registry"
import { SETTINGS_SECTION_IDS } from "./settings-section-ids"
import { buildSecurityHeaders } from "../domains/auth/ingress-policy"

test("settings-security protects all webserver_* keys as admin system settings and redacts private keys", () => {
  assert.equal(isSystemSetting("webserver_ports"), true)
  assert.equal(isSystemSetting("webserver_internal_url"), true)
  assert.equal(isSystemSetting("webserver_external_url"), true)
  assert.equal(isSystemSetting("webserver_home_assistant_url"), true)
  assert.equal(isSystemSetting("webserver_bind_address"), true)
  assert.equal(isSystemSetting("webserver_tls_enabled"), true)
  assert.equal(isSystemSetting("webserver_ssl_certificate"), true)
  assert.equal(isSystemSetting("webserver_ssl_private_key"), true)

  assert.equal(isSecretSetting("webserver_ssl_private_key"), true)
  assert.equal(isSecretSetting("custom_private_key"), true)
  assert.equal(isSecretSetting("webserver_ports"), false)
  assert.equal(isSecretSetting("webserver_internal_url"), false)
})

test("settings-registry resolves webserver and plugin aliases and indexes fields in universal search", () => {
  assert.equal(resolveSettingsSectionId("webserver-settings"), "webserver-settings")
  assert.equal(resolveSettingsSectionId("server-settings"), "webserver-settings")
  assert.equal(resolveSettingsSectionId("network-settings"), "webserver-settings")
  assert.equal(resolveSettingsSectionId("ports-settings"), "webserver-settings")
  assert.equal(resolveSettingsSectionId("plugins-settings"), "plugins-settings")
  assert.equal(resolveSettingsSectionId("extensions-settings"), "plugins-settings")
  assert.equal(resolveSettingsSectionId("addons-settings"), "plugins-settings")

  const portHits = searchSettingsRegistry("ports")
  assert.equal(portHits.some((item) => item.sectionId === "webserver-settings"), true)

  const mcpHits = searchSettingsRegistry("mcp server")
  assert.equal(mcpHits.some((item) => item.id === "field-webserver-mcp" && item.anchorId === "ws-mcp-url-text"), true)

  const tlsHits = searchSettingsRegistry("ssl")
  assert.equal(tlsHits.some((item) => item.id === "field-webserver-tls"), true)

  const pluginHits = searchSettingsRegistry("plugins")
  assert.equal(pluginHits.some((item) => item.sectionId === "plugins-settings"), true)

  const githubHits = searchSettingsRegistry("github")
  assert.equal(githubHits.some((item) => item.id === "field-plugins-connectors"), true)

  const navLayoutField = SETTINGS_FIELDS.find((field) => field.id === "field-navigation-layout")
  assert.equal(navLayoutField?.sectionId, "look-and-feel-settings")
  assert.equal(navLayoutField?.anchorId, "navigation-appearance-form")

  const shortcutHits = searchSettingsRegistry("keyboard shortcuts")
  assert.equal(shortcutHits.some((item) => item.sectionId === "navigation-settings"), true)
})

test("settings-registry DDD domain groups cover all canonical sections and every field anchor exists in Settings templates", () => {
  const validGroups = new Set(SETTINGS_DOMAIN_GROUPS.map((g) => g.id))
  const validIds = new Set<string>(SETTINGS_SECTION_IDS)

  assert.equal(SETTINGS_SECTIONS.length, SETTINGS_SECTION_IDS.length)
  for (const id of SETTINGS_SECTION_IDS) {
    const desc = SETTINGS_SECTIONS.find((s) => s.id === id)
    assert.ok(desc, `Missing section descriptor for ${id}`)
    assert.equal(validGroups.has(desc.domainGroup), true, `Invalid domainGroup on ${id}`)
  }

  const grouped = getGroupedSettingsSections()
  assert.equal(grouped.length, 4)
  const flattenedIds = grouped.flatMap((g) => g.sections.map((s) => s.id))
  assert.equal(flattenedIds.length, SETTINGS_SECTION_IDS.length)
  assert.equal(new Set(flattenedIds).size, SETTINGS_SECTION_IDS.length)

  for (const [alias, target] of Object.entries(LEGACY_SETTINGS_SECTION_ALIASES)) {
    assert.equal(validIds.has(target), true, `Legacy alias ${alias} points to unknown section ${target}`)
  }

  const webRoot = join(import.meta.dirname, "..")
  const templateFiles = [join(webRoot, "pages", "settings.astro")]
  const collectTemplates = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) collectTemplates(full)
      else if (entry.name.endsWith(".astro")) templateFiles.push(full)
    }
  }
  collectTemplates(join(webRoot, "components", "settings"))
  const markup = templateFiles.map((file) => readFileSync(file, "utf8")).join("\n")

  for (const field of SETTINGS_FIELDS) {
    assert.equal(validIds.has(field.sectionId), true, `Field ${field.id} has unknown sectionId ${field.sectionId}`)
    const hasExactId = markup.includes(`id="${field.anchorId}"`) || markup.includes(`id='${field.anchorId}'`)
    assert.equal(hasExactId, true, `Field ${field.id} anchorId "${field.anchorId}" not found in Settings Astro templates`)
  }
})

test("buildSecurityHeaders enforces clickjacking defense in production standalone and allows HA ingress framing", () => {
  const prodStandalone = buildSecurityHeaders(false, false)
  assert.equal(prodStandalone["X-Frame-Options"], "SAMEORIGIN")
  assert.equal(prodStandalone["Content-Security-Policy"]?.includes("frame-ancestors 'self'"), true)

  const prodIngress = buildSecurityHeaders(true, false)
  assert.equal(prodIngress["X-Frame-Options"], undefined)
  assert.equal(prodIngress["Content-Security-Policy"]?.includes("frame-ancestors *"), true)
})

test("canManageSystemSettings allows Cloud Run preview hosts and HA admins while blocking untrusted hosts and agents", () => {
  const prevSup = process.env.SUPERVISOR_TOKEN
  const prevKService = process.env.K_SERVICE
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.K_SERVICE = "ais-pre-preview"

    assert.equal(
      canManageSystemSettings(new Request("https://ais-pre-abc123.europe-west2.run.app/api/plugins"), {
        hassIsAdmin: false,
        agentToken: undefined,
      }),
      true,
    )
    assert.equal(
      canManageSystemSettings(new Request("https://ais-dev-abc123.europe-west2.run.app/api/plugins"), {
        hassIsAdmin: false,
        agentToken: undefined,
      }),
      true,
    )
    assert.equal(
      canManageSystemSettings(new Request("https://evil.example.com/api/plugins"), {
        hassIsAdmin: false,
        agentToken: undefined,
      }),
      false,
    )
    assert.equal(
      canManageSystemSettings(new Request("https://ais-pre-abc123.europe-west2.run.app/api/plugins"), {
        hassIsAdmin: true,
        agentToken: {
          tokenId: "tok-1",
          tokenName: "bot",
          scopes: ["tasks:read"],
          assigneeId: null,
          boardIds: [],
        },
      }),
      false,
    )

    process.env.SUPERVISOR_TOKEN = "ha-supervisor-token"
    assert.equal(
      canManageSystemSettings(new Request("https://ais-pre-abc123.europe-west2.run.app/api/plugins"), {
        hassIsAdmin: false,
        agentToken: undefined,
      }),
      false,
    )
    assert.equal(
      canManageSystemSettings(new Request("https://ais-pre-abc123.europe-west2.run.app/api/plugins"), {
        hassIsAdmin: true,
        agentToken: undefined,
      }),
      true,
    )
  } finally {
    if (prevSup === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = prevSup
    if (prevKService === undefined) delete process.env.K_SERVICE
    else process.env.K_SERVICE = prevKService
  }
})
