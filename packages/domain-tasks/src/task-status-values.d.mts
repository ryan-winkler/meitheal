export const TASK_STATUS: {
  readonly BACKLOG: "backlog"
  readonly PENDING: "pending"
  readonly ACTIVE: "active"
  readonly COMPLETE: "complete"
}

export const TASK_STATUS_ALIASES: Readonly<Record<(typeof TASK_STATUS)[keyof typeof TASK_STATUS], readonly string[]>>
