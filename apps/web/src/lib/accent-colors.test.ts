import test from "node:test"
import assert from "node:assert/strict"
import { INDIGO_SWATCH } from "./design-tokens"
import { applyPersonalAccent } from "./accent-colors"

function createMockRoot() {
  const map = new Map<string, string>()
  return {
    values: map,
    style: {
      setProperty(k: string, v: string) { map.set(k, v) },
      removeProperty(k: string) { map.delete(k) },
    },
  } as unknown as HTMLElement & { values: Map<string, string> }
}

function hexLuminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(p => parseInt(p, 16))
  const linear = rgb.map(c => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function ratio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test("applyPersonalAccent computes WCAG AA dark and light text tokens for every preset", () => {
  const presets = ["#69E3B2", INDIGO_SWATCH, "#14b8a6", "#3b82f6", "#6495ed", "#8b5cf6", "#ec4899", "#f59e0b", "#ef4444"]
  for (const hex of presets) {
    const root = createMockRoot()
    applyPersonalAccent(root, hex)
    const darkText = root.values.get("--personal-accent-text-dark")
    const lightText = root.values.get("--personal-accent-text-light")
    assert.ok(darkText && /^#[0-9a-f]{6}$/i.test(darkText), `expected dark text hex for ${hex}`)
    assert.ok(lightText && /^#[0-9a-f]{6}$/i.test(lightText), `expected light text hex for ${hex}`)
    assert.ok(ratio(hexLuminance(darkText), 0.015) >= 4.5, `${hex} dark text ${darkText} contrast < 4.5`)
    assert.ok(ratio(hexLuminance(lightText), 1) >= 4.5, `${hex} light text ${lightText} contrast < 4.5`)
  }
})

test("applyPersonalAccent clears all personal accent properties when null or invalid", () => {
  const root = createMockRoot()
  applyPersonalAccent(root, "#8b5cf6")
  assert.equal(root.values.size, 6)
  applyPersonalAccent(root, null)
  assert.equal(root.values.size, 0)
})
