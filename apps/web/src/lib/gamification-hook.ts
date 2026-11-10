/**
 * Gamification client hook — call after task completion to record stats + trigger confetti.
 *
 * @domain gamification
 * @bounded-context gamification
 *
 * @kcs This module provides a client-side function that:
 * 1. POSTs to /api/gamification with task priority
 * 2. Server computes weighted XP (P1=50, P2=40, P3=30, P4=20, P5=10)
 * 3. Checks achievements and awards new ones
 * 4. Triggers confetti animation via window.triggerConfetti()
 * 5. Shows XP earned, streak milestone, achievement unlock, and level-up toasts
 *
 * Import this in any page script that handles task completion events.
 */

import { showToast } from "@lib/toast"

/** Track previous level to detect level-ups */
let lastKnownLevel = 0

/**
 * Record a task completion and trigger celebration effects.
 * @param priority - Task priority (1=Critical → 5=Minimal). XP is computed server-side.
 */
export async function onTaskCompleted(priority = 3): Promise<void> {
  // Feature flag guard — skip gamification when disabled
  if (window.__featureFlags?.gamification === false) return

  try {
    const res = await fetch("/api/gamification", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority }),
    })

    if (res.ok) {
      const data = await res.json()

      // Trigger confetti
      if (data.confetti && typeof window.triggerConfetti === "function") {
        window.triggerConfetti()
      }

      // Show XP toast
      if (data.xp) {
        showToast(`+${data.xp} XP`, "success")
      }

      // Show streak toast for milestones
      const streak = data.stats?.currentStreak ?? 0
      if (streak > 0 && streak % 5 === 0) {
        showToast(`🔥 ${streak} day streak!`, "success")
      }

      // Show level-up toast
      if (data.level && lastKnownLevel > 0 && data.level > lastKnownLevel) {
        setTimeout(() => {
          showToast(`🎉 Level Up! You're now Level ${data.level}`, "success")
        }, 600)
      }
      if (data.level) {
        lastKnownLevel = data.level
      }

      // Show achievement unlock toasts
      if (Array.isArray(data.newAchievements) && data.newAchievements.length > 0) {
        data.newAchievements.forEach((a: { icon: string, name: string }, i: number) => {
          setTimeout(() => {
            showToast(`${a.icon} Achievement: ${a.name}`, "success")
          }, 800 + i * 500)
        })
      }
    }
  } catch {
    // Non-critical — don't block the completion flow
  }
}

