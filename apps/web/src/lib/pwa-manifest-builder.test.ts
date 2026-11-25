import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildPwaManifest,
  PWA_TASK_SHORTCUT_KINDS,
  resolvePwaTaskKind,
  sanitizeIngressPrefix,
} from "./pwa-manifest-builder"

describe("pwa-manifest-builder", () => {
  it("builds a complete W3C default manifest with shortcuts, share_target, and separated icon purposes", () => {
    const manifest = buildPwaManifest("", null)
    assert.equal(manifest.id, "/")
    assert.equal(manifest.name, "Meitheal")
    assert.ok(manifest.short_name.length <= 12)
    assert.equal(manifest.start_url, "/")
    assert.equal(manifest.scope, "/")
    assert.equal(manifest.display, "standalone")
    assert.deepEqual(manifest.display_override, ["window-controls-overlay", "standalone"])
    assert.equal(manifest.launch_handler.client_mode, "focus-existing")
    assert.equal(manifest.share_target.action, "/new")
    assert.ok(manifest.shortcuts.some((s) => s.url === "/new?kind=standard_action"))
    assert.ok(manifest.shortcuts.some((s) => s.url === "/new?kind=shopping_item"))
    assert.ok(manifest.shortcuts.every((s) => s.short_name.length <= 12))
    assert.ok(manifest.icons.some((i) => i.sizes === "192x192" && i.purpose === "any"))
    assert.ok(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any"))
    assert.ok(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"))
    assert.ok(manifest.icons.every((i) => i.purpose !== ("any maskable" as unknown)))
  })

  it("builds dedicated installable manifests per task kind while preserving ingress prefix", () => {
    const manifest = buildPwaManifest("/api/hassio_ingress/abc123/", "shopping_item")
    assert.equal(manifest.id, "/new?kind=shopping_item")
    assert.equal(manifest.name, "Meitheal — New Shopping")
    assert.equal(manifest.short_name, "Shopping")
    assert.ok(manifest.short_name.length <= 12)
    assert.equal(manifest.start_url, "/api/hassio_ingress/abc123/new?kind=shopping_item")
    assert.equal(manifest.scope, "/api/hassio_ingress/abc123/")
    assert.equal(manifest.share_target.action, "/api/hassio_ingress/abc123/new")
    assert.equal(manifest.icons[0]?.src, "/api/hassio_ingress/abc123/icon-192.png")
    assert.equal(manifest.shortcuts[0]?.url, "/api/hassio_ingress/abc123/new?kind=standard_action")
  })

  it("ensures all task shortcut specs have valid short_name <= 12 chars and rejects unknown kinds", () => {
    for (const spec of PWA_TASK_SHORTCUT_KINDS) {
      assert.ok(spec.shortName.length <= 12, `${spec.kind} shortName too long`)
      assert.equal(resolvePwaTaskKind(spec.kind)?.kind, spec.kind)
    }
    assert.equal(resolvePwaTaskKind("malicious_kind"), null)
    const fallback = buildPwaManifest("", "malicious_kind")
    assert.equal(fallback.id, "/")
    assert.equal(fallback.start_url, "/")
  })

  it("sanitizes unsafe ingress prefixes to prevent open-redirect manifest URLs", () => {
    assert.equal(sanitizeIngressPrefix("//evil.example"), "")
    assert.equal(sanitizeIngressPrefix("https://evil.example"), "")
    assert.equal(sanitizeIngressPrefix("/api/hassio_ingress/tok_1/"), "/api/hassio_ingress/tok_1")
  })
})
