/**
 * User Profile Domain Model
 *
 * Pure domain representation for the signed-in / local user profile displayed
 * in the sidebar footer and editable through the Edit Profile modal.
 */

export interface UserProfile {
  displayName: string
  username: string
  role: string
  avatarColor: string
}

export interface AvatarColorPreset {
  id: string
  label: string
  hex: string
  textColor: string
}

export const THEME_AVATAR_COLOR = "theme"

export const AVATAR_COLOR_PRESETS: readonly AvatarColorPreset[] = [
  { id: "theme", label: "Match theme", hex: THEME_AVATAR_COLOR, textColor: "auto" },
  { id: "sky", label: "Sky", hex: "#0ea5e9", textColor: "#ffffff" },
  { id: "mint", label: "Mint", hex: "#10b981", textColor: "#ffffff" },
  { id: "indigo", label: "Indigo", hex: "#6366f1", textColor: "#ffffff" },
  { id: "violet", label: "Violet", hex: "#8b5cf6", textColor: "#ffffff" },
  { id: "rose", label: "Rose", hex: "#e11d48", textColor: "#ffffff" },
  { id: "amber", label: "Amber", hex: "#d97706", textColor: "#ffffff" },
  { id: "teal", label: "Teal", hex: "#0d9488", textColor: "#ffffff" },
  { id: "slate", label: "Slate", hex: "#475569", textColor: "#ffffff" },
] as const

export const DEFAULT_USER_PROFILE: Readonly<UserProfile> = {
  displayName: "Household Member",
  username: "local",
  role: "",
  avatarColor: THEME_AVATAR_COLOR,
}

const VALID_HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function isThemeAvatarColor(color: string | undefined | null): boolean {
  return !color || color === THEME_AVATAR_COLOR
}

export function avatarContrastForeground(hex: string): "#000000" | "#ffffff" {
  if (!VALID_HEX_COLOR.test(hex)) return "#ffffff"
  const rgb = hex.slice(1).match(/../g)!.map(pair => parseInt(pair, 16))
  const linear = rgb.map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff"
}

function isValidAvatarColor(value: unknown): value is string {
  return value === THEME_AVATAR_COLOR || (typeof value === "string" && VALID_HEX_COLOR.test(value))
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function cleanUsername(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 40)
}

function parseRawProfile(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      const first: unknown = JSON.parse(raw)
      if (typeof first === "string") {
        const second: unknown = JSON.parse(first)
        return second && typeof second === "object" && !Array.isArray(second)
          ? (second as Record<string, unknown>)
          : {}
      }
      return first && typeof first === "object" && !Array.isArray(first)
        ? (first as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

export function normalizeUserProfile(
  raw: unknown,
  fallback?: Partial<UserProfile>,
): UserProfile {
  const source = parseRawProfile(raw)
  const base: UserProfile = {
    displayName: cleanText(fallback?.displayName, 60) || DEFAULT_USER_PROFILE.displayName,
    username: cleanUsername(fallback?.username) || DEFAULT_USER_PROFILE.username,
    role: cleanText(fallback?.role, 60) || DEFAULT_USER_PROFILE.role,
    avatarColor: isValidAvatarColor(fallback?.avatarColor)
      ? fallback.avatarColor
      : DEFAULT_USER_PROFILE.avatarColor,
  }

  const displayName = cleanText(source.displayName, 60) || base.displayName
  const username = cleanUsername(source.username) || base.username
  const role = typeof source.role === "string" ? cleanText(source.role, 60) : base.role
  const avatarColor = isValidAvatarColor(source.avatarColor)
    ? source.avatarColor
    : base.avatarColor

  return { displayName, username, role, avatarColor }
}

export type ValidateProfileResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; errorCode: "DISPLAY_NAME_REQUIRED" | "INVALID_COLOR"; message: string }

export function validateUserProfile(input: {
  displayName?: unknown
  username?: unknown
  role?: unknown
  avatarColor?: unknown
}): ValidateProfileResult {
  const displayName = cleanText(input.displayName, 60)
  if (!displayName) {
    return {
      ok: false,
      errorCode: "DISPLAY_NAME_REQUIRED",
      message: "Display name is required.",
    }
  }
  const avatarColor =
    typeof input.avatarColor === "string" && input.avatarColor.trim()
      ? input.avatarColor.trim()
      : DEFAULT_USER_PROFILE.avatarColor
  if (!isValidAvatarColor(avatarColor)) {
    return {
      ok: false,
      errorCode: "INVALID_COLOR",
      message: "Avatar color must match the theme or be a valid hex color.",
    }
  }
  const username = cleanUsername(input.username) || displayName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "local"
  const role = cleanText(input.role, 60)

  return {
    ok: true,
    profile: { displayName, username, role, avatarColor },
  }
}

export function profileInitials(profile: Pick<UserProfile, "displayName" | "username">): string {
  const source = cleanText(profile.displayName, 60) || cleanUsername(profile.username) || "M"
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase()
  }
  return (parts[0]?.[0] ?? "M").toUpperCase()
}

export function profileSubtitle(profile: Pick<UserProfile, "username" | "role">): string {
  return cleanText(profile.role, 60) || cleanUsername(profile.username) || "local"
}
