/**
 * Habits Domain — Public API
 *
 * @kcs This barrel file is the only public import path for the habits domain.
 * Cross-context imports should use: import { ... } from "@domains/habits"
 */

export {
  ensureHabitSchema,
  createHabit,
  getHabits,
  completeHabit,
  deleteHabit,
  resetHabitSchemaForTests,
  type Habit,
  type HabitWithStats,
} from "./habit-service"
