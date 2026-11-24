/**
 * Gamification Domain — Public API
 *
 * @kcs This barrel file is the only public import path for the gamification domain.
 * Cross-context imports should use: import { ... } from "@domains/gamification"
 */

export {
  recordTaskCompletion,
  getStats,
  getDailyProgress,
  getWeeklyData,
  getXpForPriority,
  ensureGamificationSchema,
  resetGamificationForTests,
  type GamificationStats,
  type DailyRecord,
} from "./streak-tracker"

export {
  getLevel,
  getXpForLevel,
  getProgressToNextLevel,
  getXpToNextLevel,
  checkAchievements,
  completeTaskGamification,
  getAllAchievements,
  getYearlyHeatmapData,
  ensureAchievementSchema,
  resetAchievementForTests,
  ACHIEVEMENTS,
  type Achievement,
  type UnlockedAchievement,
  type AchievementCheckResult,
  type TaskCompletionGamificationResult,
} from "./achievement-engine"
