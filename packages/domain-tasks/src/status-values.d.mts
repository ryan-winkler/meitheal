export declare const TASK_STATUS: {
  readonly BACKLOG: "backlog"
  readonly PENDING: "pending"
  readonly ACTIVE: "active"
  readonly COMPLETE: "complete"
}

export type CanonicalTaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS]

export declare const TASK_STATUS_ALIASES: {
  readonly [K in CanonicalTaskStatus]: readonly string[]
}
