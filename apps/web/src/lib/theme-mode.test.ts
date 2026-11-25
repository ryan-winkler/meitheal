import test from "node:test"
import assert from "node:assert/strict"
import {
  LIGHT_THEME_MODES,
  THEME_META_COLORS,
  THEME_MODES,
  isLightThemeMode,
  isNamedThemeMode,
  isThemeMode,
} from "./theme-mode"

test("curated light themes are registered in THEME_MODES and LIGHT_THEME_MODES", () => {
  const expectedLight = [
    "light",
    "zen-paper",
    "catppuccin-latte",
    "nordic-frost",
    "solarized-dawn",
  ]
  for (const mode of expectedLight) {
    assert.equal(isThemeMode(mode), true, `${mode} should be a valid ThemeMode`)
    assert.equal(isLightThemeMode(mode), true, `${mode} should resolve as a light theme`)
    assert.ok(THEME_META_COLORS[mode], `${mode} should define a meta theme-color`)
  }
  assert.equal(LIGHT_THEME_MODES.length, expectedLight.length)
})

test("dark and special themes are distinguished from light themes", () => {
  const expectedDarkNamed = ["knight-rider", "plainspace", "velvet", "liquid-glass", "rainbow"]
  assert.equal(isThemeMode("dark"), true)
  assert.equal(isThemeMode("auto"), true)
  assert.equal(isThemeMode("custom"), true)
  assert.equal(isLightThemeMode("dark"), false)
  for (const mode of expectedDarkNamed) {
    assert.equal(isThemeMode(mode), true, `${mode} should be a valid ThemeMode`)
    assert.equal(isLightThemeMode(mode), false, `${mode} should resolve as dark`)
    assert.equal(isNamedThemeMode(mode), true, `${mode} should be a named theme`)
    assert.ok(THEME_META_COLORS[mode], `${mode} should define a meta theme-color`)
  }
  assert.equal(isNamedThemeMode("zen-paper"), true)
  assert.equal(isNamedThemeMode("light"), false)
  assert.equal(isThemeMode("unknown-theme"), false)
  assert.ok(THEME_MODES.includes("solarized-dawn"))
})
