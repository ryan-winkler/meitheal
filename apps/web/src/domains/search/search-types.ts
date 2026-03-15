export type SearchScope = "all" | "tasks" | "views" | "settings" | "actions"

export type SearchSort = "relevance" | "updated"

export type TaskSearchField =
  | "id"
  | "title"
  | "description"
  | "labels"
  | "custom_fields"
  | "comments"

export interface SearchQueryOptions {
  query: string
  scope: SearchScope
  limit: number
  includeCompleted: boolean
  includeArchived: boolean
  sort: SearchSort
  taskFields: TaskSearchField[]
  status?: string
  priority?: number
  assignedTo?: string
}

export interface SearchResultItem {
  id: string
  kind:
    | "task"
    | "board"
    | "saved_filter"
    | "setting"
    | "page"
    | "action"
  title: string
  subtitle?: string
  description?: string
  href?: string
  taskId?: string
  actionId?: string
  icon?: string
  color?: string | null
  meta?: Record<string, unknown>
}

export interface SearchResultSection {
  id: string
  label: string
  items: SearchResultItem[]
}

export interface SearchResponse {
  query: string
  sections: SearchResultSection[]
  meta: {
    scope: SearchScope
    limit: number
    include_completed: boolean
    include_archived: boolean
    sort: SearchSort
    task_fields: TaskSearchField[]
  }
}
