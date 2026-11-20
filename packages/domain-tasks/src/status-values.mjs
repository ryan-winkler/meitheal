export const TASK_STATUS = Object.freeze({
  BACKLOG: "backlog",
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETE: "complete",
})

export const TASK_STATUS_ALIASES = Object.freeze({
  [TASK_STATUS.BACKLOG]: Object.freeze(["icebox"]),
  [TASK_STATUS.PENDING]: Object.freeze(["todo", "open"]),
  [TASK_STATUS.ACTIVE]: Object.freeze(["in_progress", "in-progress", "doing"]),
  [TASK_STATUS.COMPLETE]: Object.freeze(["done", "completed", "closed"]),
})
