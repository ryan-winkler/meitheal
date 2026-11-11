/** Celebrate only the authoritative result of an acknowledged task transition. */
import { showToast } from "@lib/toast"

export interface TaskCompletionResponse {
  gamification?: {
    error?: string
    stats?: { currentStreak: number }
    xp?: number
    confetti?: boolean
    level?: number
    newAchievements?: Array<{ icon: string; name: string }>
  }
}

let lastKnownLevel = 0

/** This presentation hook never records completions or makes API requests. */
export async function onTaskCompleted(completion?: TaskCompletionResponse): Promise<void> {
  if (window.__featureFlags?.gamification === false) return
  const data = completion?.gamification
  // Repeated complete writes and non-task operations have no earned event.
  if (!data) return
  if (data.error) {
    showToast(data.error, "warning")
    return
  }
  if (data.confetti && typeof window.triggerConfetti === "function") window.triggerConfetti()
  if (data.xp) showToast(`+${data.xp} XP`, "success")
  const streak = data.stats?.currentStreak ?? 0
  if (streak > 0 && streak % 5 === 0) showToast(`🔥 ${streak} day streak!`, "success")
  if (data.level && lastKnownLevel > 0 && data.level > lastKnownLevel) {
    setTimeout(() => showToast(`🎉 Level Up! You're now Level ${data.level}`, "success"), 600)
  }
  if (data.level) lastKnownLevel = data.level
  data.newAchievements?.forEach((achievement, index) => {
    setTimeout(() => showToast(`${achievement.icon} Achievement: ${achievement.name}`, "success"), 800 + index * 500)
  })
}
