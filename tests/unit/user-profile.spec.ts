import { expect, test } from "@playwright/test"
import {
  DEFAULT_USER_PROFILE,
  THEME_AVATAR_COLOR,
  avatarContrastForeground,
  isThemeAvatarColor,
  normalizeUserProfile,
  profileInitials,
  validateUserProfile,
} from "../../apps/web/src/domains/auth/user-profile"
import { INDIGO_SWATCH } from "../../apps/web/src/lib/design-tokens"

test("default user profile uses the current theme's avatar color", () => {
  expect(DEFAULT_USER_PROFILE.avatarColor).toBe(THEME_AVATAR_COLOR)
  expect(isThemeAvatarColor(DEFAULT_USER_PROFILE.avatarColor)).toBe(true)
  expect(isThemeAvatarColor(null)).toBe(true)
  expect(isThemeAvatarColor(INDIGO_SWATCH)).toBe(false)
})

test("normalization accepts theme colors and custom hex colors", () => {
  expect(normalizeUserProfile({}).avatarColor).toBe("theme")
  expect(normalizeUserProfile({ avatarColor: "theme" }).avatarColor).toBe("theme")
  expect(normalizeUserProfile({ avatarColor: "#8b5cf6" }).avatarColor).toBe("#8b5cf6")
  expect(normalizeUserProfile({ avatarColor: "not-a-color" }).avatarColor).toBe("theme")
})

test("validation accepts theme colors and rejects malformed colors", () => {
  expect(validateUserProfile({ displayName: "Ryan", avatarColor: "theme" })).toMatchObject({
    ok: true, profile: { avatarColor: "theme" },
  })
  expect(validateUserProfile({ displayName: "Ryan", avatarColor: "#146C4E" }).ok).toBe(true)
  expect(validateUserProfile({ displayName: "Ryan", avatarColor: "rgb(1,2,3)" })).toMatchObject({
    ok: false, errorCode: "INVALID_COLOR",
  })
})

test("avatar text keeps its contrast with custom background colors", () => {
  expect(avatarContrastForeground("#69E3B2")).toBe("#000000")
  expect(avatarContrastForeground("#146C4E")).toBe("#ffffff")
  expect(avatarContrastForeground("#111827")).toBe("#ffffff")
  expect(avatarContrastForeground("#FACC15")).toBe("#000000")
})

test("initials use the first two names and fall back to the username", () => {
  expect(profileInitials({ displayName: "  Alex   Kelly Quinn ", username: "alex" })).toBe("AK")
  expect(profileInitials({ displayName: "", username: "alex" })).toBe("A")
  expect(profileInitials({ displayName: "", username: "" })).toBe("M")
})
