import test from "node:test"
import assert from "node:assert/strict"
import { buildPluginZip, extractPluginZip } from "./plugin-zip"

const VALID_MANIFEST = JSON.stringify({
  id: "zip-sample",
  name: "Zip Sample",
  version: "1.0.0",
  minMeithealVersion: "0.0.2",
  type: "extension",
  description: "Sample extension packaged as a ZIP.",
  author: "Tester",
  license: "MIT",
  entry: "plugin.js",
  permissions: ["tasks:read"],
  hooks: [],
  allowedHosts: [],
  dataSharing: {
    outbound: false,
    destinations: [],
    dataTypes: [],
    summary: "Local only sample plugin.",
  },
})

test("extracts valid root and single-subfolder plugin ZIPs", () => {
  const rootZip = buildPluginZip([
    { name: "manifest.json", content: VALID_MANIFEST },
    { name: "plugin.js", content: "MeithealPlugin.onInit(() => {})" },
  ])
  const res1 = extractPluginZip(rootZip)
  assert.equal(res1.ok, true)
  if (res1.ok) {
    assert.equal(res1.data.files.has("manifest.json"), true)
    assert.equal(res1.data.sha256.length, 64)
  }

  const nestedZip = buildPluginZip([
    { name: "zip-sample/manifest.json", content: VALID_MANIFEST },
    { name: "zip-sample/plugin.js", content: "MeithealPlugin.onInit(() => {})" },
  ])
  const res2 = extractPluginZip(nestedZip)
  assert.equal(res2.ok, true)
  if (res2.ok) {
    assert.equal(res2.data.files.has("manifest.json"), true)
    assert.equal(res2.data.files.has("plugin.js"), true)
  }
})

test("rejects Zip Slip path traversal and absolute paths", () => {
  const slipZip = buildPluginZip([
    { name: "manifest.json", content: VALID_MANIFEST },
    { name: "../../etc/passwd", content: "root:x:0:0" },
  ])
  const res = extractPluginZip(slipZip)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "INVALID_ARCHIVE_PATH")

  const absZip = buildPluginZip([
    { name: "/etc/shadow.json", content: "{}" },
  ])
  const resAbs = extractPluginZip(absZip)
  assert.equal(resAbs.ok, false)
  if (!resAbs.ok) assert.equal(resAbs.errorCode, "INVALID_ARCHIVE_PATH")
})

test("rejects Unix symbolic links inside ZIP archives", () => {
  const symlinkZip = buildPluginZip([
    { name: "manifest.json", content: VALID_MANIFEST },
    { name: "plugin.js", content: "/etc/passwd", unixMode: 0o120777 },
  ])
  const res = extractPluginZip(symlinkZip)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "INVALID_ARCHIVE_PATH")
})

test("rejects disallowed executable file extensions", () => {
  const exeZip = buildPluginZip([
    { name: "manifest.json", content: VALID_MANIFEST },
    { name: "run.sh", content: "#!/bin/sh\necho hi" },
  ])
  const res = extractPluginZip(exeZip)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "DISALLOWED_FILE_TYPE")
})

test("rejects high-ratio zip bombs (>20:1 compression ratio)", () => {
  // 512 KB of zeroes compresses to < 600 bytes (~850:1 ratio)
  const bombZip = buildPluginZip([
    { name: "manifest.json", content: VALID_MANIFEST },
    { name: "plugin.js", content: Buffer.alloc(512 * 1024, 0x20), compress: true },
  ])
  const res = extractPluginZip(bombZip)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.errorCode, "ZIP_BOMB_DETECTED")
})
