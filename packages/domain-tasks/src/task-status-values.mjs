export const TASK_STATUS = {
  BACKLOG: "backlog",
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETE: "complete",
}

export const TASK_STATUS_ALIASES = {
  [TASK_STATUS.BACKLOG]: [],
  [TASK_STATUS.PENDING]: ["todo"],
  [TASK_STATUS.ACTIVE]: ["in_progress"],
  [TASK_STATUS.COMPLETE]: ["done"],
}
