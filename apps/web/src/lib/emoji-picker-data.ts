/**
 * EmojiPicker — curated emoji grid for area/project icon selection
 *
 * Provides a searchable grid of commonly used emoji organized by category.
 * Renders as a popover panel, typically anchored to a trigger button.
 *
 * Categories:
 * - Common (home, work, etc.)
 * - Objects
 * - Nature
 * - Activities
 * - Symbols
 *
 * @domain shared/ui
 */

/** Curated emoji organized by category for area/project icon selection */
export const EMOJI_CATEGORIES: Array<{ label: string; emoji: string[] }> = [
  {
    label: "Common",
    emoji: [
      "🏠", "📋", "📁", "📂", "🗂️", "📌", "⭐", "💡", "🎯", "🚀",
      "🔧", "⚙️", "🛠️", "📊", "📈", "💰", "🏢", "🏗️", "🎓", "📚",
      "✅", "📝", "📅", "🕐", "⏰", "🗓️", "📱", "💻", "🖥️", "🌐",
    ],
  },
  {
    label: "People",
    emoji: [
      "👤", "👥", "🤝", "👨‍💻", "👩‍💻", "👨‍🔬", "👩‍🎨", "🧑‍🍳", "💪", "🧠",
      "❤️", "🙏", "👋", "✋", "👍", "🎉", "😊", "🤔", "😤", "🎭",
    ],
  },
  {
    label: "Nature",
    emoji: [
      "🌿", "🌱", "🌳", "🌸", "🌺", "🌻", "🍃", "🍀", "🌙", "☀️",
      "⛅", "🌈", "💧", "🔥", "⚡", "❄️", "🌊", "🏔️", "🐾", "🦋",
    ],
  },
  {
    label: "Objects",
    emoji: [
      "🏡", "🏠", "🚗", "✈️", "🚂", "🎵", "🎬", "📷", "🎮", "🎨",
      "🔑", "🔒", "💎", "🎁", "🧩", "🎲", "🪴", "🛒", "🧹", "🧺",
      "🍕", "☕", "🍻", "🥗", "🧁", "🍎", "🥑", "🧃", "🍳", "🧂",
    ],
  },
  {
    label: "Symbols",
    emoji: [
      "💜", "💙", "💚", "💛", "🧡", "❤️", "🖤", "🤍", "💝", "✨",
      "🔴", "🟢", "🔵", "🟡", "🟠", "🟣", "⬛", "⬜", "🏳️", "🏴",
    ],
  },
]

/** Flat list of all emoji for search */
export function searchEmoji(query: string): string[] {
  if (!query.trim()) return EMOJI_CATEGORIES.flatMap((c) => c.emoji)
  // Simple substring match won't work for emoji names — return all for now
  // A full emoji search library would map emoji to English names
  return EMOJI_CATEGORIES.flatMap((c) => c.emoji)
}
