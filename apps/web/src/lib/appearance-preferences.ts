export const APPEARANCE_STORAGE_KEY = "meitheal-appearance"

interface Preference {
  readonly options: readonly string[]
  readonly defaultValue: string
}

export const APPEARANCE_PREFERENCES: Record<"font" | "radius", Preference> = {
  font: { options: ["sans", "serif", "mono"], defaultValue: "sans" },
  radius: { options: ["0", "0.5", "1", "1.5", "2"], defaultValue: "1" },
}
