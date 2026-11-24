import test from "node:test"
import assert from "node:assert/strict"
import { sanitizePluginIconSvg, validatePluginManifest } from "./plugin-manifest"

function baseManifest() {
  return {
    id: "my-extension",
    name: "My Extension",
    version: "1.0.0",
    minMeithealVersion: "0.0.2",
    type: "extension",
    description: "Adds a tidy carryover panel to Meitheal.",
    author: "Tester",
    license: "MIT",
    entry: "plugin.js",
    iFrame: "index.html",
    sidePanel: true,
    permissions: ["tasks:read", "ui:side-panel"],
    hooks: ["task.completed"],
    allowedHosts: [],
    dataSharing: {
      outbound: false,
      destinations: [],
      dataTypes: [],
      summary: "Runs locally without sending data outside Meitheal.",
    },
  }
}

test("accepts valid extension manifest", () => {
  const res = validatePluginManifest(baseManifest())
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.data.id, "my-extension")
    assert.equal(res.data.sidePanel, true)
  }
})

test("rejects allowedHosts missing from dataSharing.destinations", () => {
  const manifest = {
    ...baseManifest(),
    permissions: ["tasks:read", "http:outbound"],
    allowedHosts: ["api.github.com"],
    dataSharing: {
      outbound: true,
      destinations: [],
      dataTypes: ["issue_title"],
      summary: "Sends requests to GitHub.",
    },
  }
  const res = validatePluginManifest(manifest)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "UNDECLARED_HOST")
})

test("rejects allowedHosts without http:outbound permission", () => {
  const manifest = {
    ...baseManifest(),
    permissions: ["tasks:read"],
    allowedHosts: ["api.github.com"],
    dataSharing: {
      outbound: true,
      destinations: [{ host: "api.github.com", purpose: "Sync issues." }],
      dataTypes: ["issue_title"],
      summary: "Syncs issues from GitHub.",
    },
  }
  const res = validatePluginManifest(manifest)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "INVALID_PERMISSION")
})

test("rejects path traversal in entry or iFrame paths", () => {
  const manifest = { ...baseManifest(), entry: "../escape.js" }
  const res = validatePluginManifest(manifest)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "INVALID_MANIFEST")
})

test("sanitizes unsafe tags and event handlers from SVG icons", () => {
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0h24" onclick="evil()" /><foreignObject><div>x</div></foreignObject></svg>`
  const res = sanitizePluginIconSvg(dirty)
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.data.includes("<script"), false)
    assert.equal(res.data.includes("onload"), false)
    assert.equal(res.data.includes("onclick"), false)
    assert.equal(res.data.includes("foreignObject"), false)
  }
})

test("rejects SVG icon containing javascript: or data: URI", () => {
  const dirtyJs = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><path d="M0 0" /></a></svg>`
  const resJs = sanitizePluginIconSvg(dirtyJs)
  assert.equal(resJs.ok, false)
  if (!resJs.ok) assert.equal(resJs.errorCode, "UNSAFE_ICON")

  const dirtyData = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz4=" /></svg>`
  const resData = sanitizePluginIconSvg(dirtyData)
  assert.equal(resData.ok, false)
  if (!resData.ok) assert.equal(resData.errorCode, "UNSAFE_ICON")
})
