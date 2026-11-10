import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { canManageSystemSettings, isSecretSetting, isSystemSetting } from "../../apps/web/src/lib/settings-security"

test("classifies integration URLs and credential fields separately", () => {
  for (const key of ["ha-token", "vikunja_token", "caldav_password_enc", "n8n_api_key", "webhook_secret", "license_key"]) {
    expect(isSecretSetting(key)).toBe(true)
    expect(isSystemSetting(key)).toBe(true)
  }
  expect(isSecretSetting("n8n_webhook_url")).toBe(false)
  expect(isSystemSetting("n8n_webhook_url")).toBe(true)
  expect(isSystemSetting("custom_theme_css")).toBe(true)
  expect(isSystemSetting("timezone")).toBe(false)
})

test("standalone administrator access checks both local peer and host", () => {
  const locals = { hassIsAdmin: false }
  const local = new Request("http://127.0.0.1:3000/api/settings")
  const hostile = new Request("http://rebinding.example:3000/api/settings", {
    headers: { "x-hass-is-admin": "true", "x-remote-user-groups": "system-admin" },
  })
  runWithIngressTransport({ peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: false, configuredPath: undefined }, () => {
    expect(canManageSystemSettings(local, locals)).toBe(!process.env.SUPERVISOR_TOKEN)
    expect(canManageSystemSettings(hostile, locals)).toBe(false)
  })
  runWithIngressTransport({ peer: "172.30.32.3", fromSupervisor: false, identityHeadersSafe: false, configuredPath: undefined }, () => {
    expect(canManageSystemSettings(local, locals)).toBe(false)
  })
  expect(canManageSystemSettings(local, { hassIsAdmin: true })).toBe(true)
  expect(canManageSystemSettings(local, {
    hassIsAdmin: true,
    agentToken: { tokenId: "synthetic", tokenName: "synthetic", scopes: ["settings:write"] },
  })).toBe(false)
})
