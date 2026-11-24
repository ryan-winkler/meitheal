import test from "node:test"
import assert from "node:assert/strict"
import { INDIGO_SWATCH } from "../../lib/design-tokens"
import {
  DEFAULT_USER_PROFILE,
  THEME_AVATAR_COLOR,
  avatarContrastForeground,
  isThemeAvatarColor,
  normalizeUserProfile,
  validateUserProfile,
} from "./user-profile"

test("default user profile uses dynamic theme avatar color", () => {
  assert.equal(DEFAULT_USER_PROFILE.avatarColor, THEME_AVATAR_COLOR)
  assert.equal(isThemeAvatarColor(DEFAULT_USER_PROFILE.avatarColor), true)
  assert.equal(isThemeAvatarColor(null), true)
  assert.equal(isThemeAvatarColor(INDIGO_SWATCH), false)
})

test("normalizeUserProfile accepts theme mode and custom hex colors", () => {
  assert.equal(normalizeUserProfile({}).avatarColor, "theme")
  assert.equal(normalizeUserProfile({ avatarColor: "theme" }).avatarColor, "theme")
  assert.equal(normalizeUserProfile({ avatarColor: "#8b5cf6" }).avatarColor, "#8b5cf6")
  assert.equal(normalizeUserProfile({ avatarColor: "not-a-color" }).avatarColor, "theme")
})

test("validateUserProfile permits theme mode and rejects malformed colors", () => {
  const themeRes = validateUserProfile({ displayName: "Ryan", avatarColor: "theme" })
  assert.equal(themeRes.ok, true)
  if (themeRes.ok) assert.equal(themeRes.profile.avatarColor, "theme")

  const hexRes = validateUserProfile({ displayName: "Ryan", avatarColor: "#146C4E" })
  assert.equal(hexRes.ok, true)

  const badRes = validateUserProfile({ displayName: "Ryan", avatarColor: "rgb(1,2,3)" })
  assert.equal(badRes.ok, false)
  if (!badRes.ok) assert.equal(badRes.errorCode, "INVALID_COLOR")
})

test("avatarContrastForeground chooses high-contrast text color", () => {
  assert.equal(avatarContrastForeground("#69E3B2"), "#000000")
  assert.equal(avatarContrastForeground("#146C4E"), "#ffffff")
  assert.equal(avatarContrastForeground("#111827"), "#ffffff")
  assert.equal(avatarContrastForeground("#FACC15"), "#000000")
})
