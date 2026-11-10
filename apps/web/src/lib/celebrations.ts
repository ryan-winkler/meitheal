/**
 * Celebrations — micro-celebrations for ADHD dopamine reinforcement.
 * @domain UI Infrastructure (Gamification context)
 *
 * Provides lightweight visual celebrations when users complete tasks,
 * hit streak milestones, or clear their Focus Stack. Designed to be
 * non-intrusive but rewarding — supporting the ADHD dopamine feedback
 * loop that makes task completion feel meaningful.
 *
 * @kcs Celebrations fire client-side only. No server round-trip needed.
 * Uses CSS animations + canvas for confetti to avoid heavy dependencies.
 */

import { showToast } from "@lib/toast"

// ─── Confetti ─────────────────────────────────────────────────────────

/** Lightweight canvas-based confetti burst — no external dependencies */
export function fireConfetti(opts?: { duration?: number; particleCount?: number }): void {
  const duration = opts?.duration ?? 1500
  const count = opts?.particleCount ?? 48
  const canvas = document.createElement("canvas")
  canvas.style.cssText = "position:fixed;inset:0;z-index:99999;pointer-events:none"
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  document.body.appendChild(canvas)

  const ctx = canvas.getContext("2d")
  if (!ctx) { canvas.remove(); return }

  const colors = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD", "#98D8C8"]
  const particles: Array<{
    x: number; y: number; vx: number; vy: number
    size: number; color: string; rotation: number; spin: number
    opacity: number
  }> = []

  // Spawn particles from center-top
  const startX = canvas.width / 2
  const startY = canvas.height * 0.3
  for (let i = 0; i < count; i++) {
    const angle = (Math.random() * Math.PI * 2)
    const speed = 3 + Math.random() * 6
    particles.push({
      x: startX + (Math.random() - 0.5) * 100,
      y: startY + (Math.random() - 0.5) * 50,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      size: 4 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      rotation: Math.random() * 360,
      spin: (Math.random() - 0.5) * 10,
      opacity: 1,
    })
  }

  const start = performance.now()
  function animate(now: number) {
    const elapsed = now - start
    const progress = Math.min(elapsed / duration, 1)
    ctx!.clearRect(0, 0, canvas.width, canvas.height)

    for (const p of particles) {
      p.x += p.vx
      p.vy += 0.15 // gravity
      p.y += p.vy
      p.rotation += p.spin
      p.opacity = 1 - progress

      ctx!.save()
      ctx!.globalAlpha = p.opacity
      ctx!.translate(p.x, p.y)
      ctx!.rotate((p.rotation * Math.PI) / 180)
      ctx!.fillStyle = p.color
      ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6)
      ctx!.restore()
    }

    if (progress < 1) {
      requestAnimationFrame(animate)
    } else {
      canvas.remove()
    }
  }
  requestAnimationFrame(animate)
}

// ─── Celebration Triggers ─────────────────────────────────────────────

/** Fire on high-priority (P1) task completion — full confetti burst */
export function celebrateHighPriorityComplete(taskTitle: string): void {
  fireConfetti({ particleCount: 64, duration: 2000 })
  showToast(`🎉 Crushed it! "${taskTitle}" done`, "success")
}

/** Fire on streak milestone (7, 14, 30, 60, 100 days) */
export function celebrateStreakMilestone(days: number): void {
  const milestoneEmoji = days >= 100 ? "💎" : days >= 60 ? "🏆" : days >= 30 ? "🔥" : days >= 14 ? "⚡" : "✨"
  fireConfetti({ particleCount: days >= 30 ? 80 : 48 })
  showToast(`${milestoneEmoji} ${days}-day streak! Keep the momentum`, "success")
}

/** Fire when all Focus Stack tasks are completed */
export function celebrateFocusStackClear(): void {
  fireConfetti({ particleCount: 56, duration: 1800 })
  showToast("🧠 Focus Stack cleared — great focus session!", "success")
}

/** Fire on daily goal completion (all tasks for today done) */
export function celebrateDailyGoalComplete(completed: number): void {
  fireConfetti({ particleCount: 48 })
  showToast(`🏁 All ${completed} tasks done today — you earned this rest`, "success")
}

/** Show WIP limit warning toast (amber, not blocking) */
export function warnWipLimitReached(areaTitle: string, limit: number): void {
  showToast(`⚠️ ${areaTitle}: WIP limit (${limit}) reached — finish something first`, "error")
}

// ─── Streak Milestone Detection ───────────────────────────────────────

const STREAK_MILESTONES = [7, 14, 30, 60, 100, 200, 365]

/** Check if a streak count crosses a milestone boundary */
export function isStreakMilestone(currentStreak: number): boolean {
  return STREAK_MILESTONES.includes(currentStreak)
}
