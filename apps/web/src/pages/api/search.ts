import type { APIRoute } from "astro"
import { ensureSchema } from "@domains/tasks/persistence/store"
import { searchMeithealCatalog } from "@domains/search/search-service"
import type { SearchQueryOptions, SearchScope, SearchSort, TaskSearchField } from "@domains/search/search-types"
import { apiError, apiJson, apiProblem } from "../../lib/api-response"
import { logApiError } from "../../lib/api-logger"

const DEFAULT_FIELDS: TaskSearchField[] = [
  "id",
  "title",
  "description",
  "labels",
  "custom_fields",
  "comments",
]

const VALID_SCOPES = new Set<SearchScope>(["all", "tasks", "views", "settings", "actions"])
const VALID_SORTS = new Set<SearchSort>(["relevance", "updated"])
const VALID_FIELDS = new Set<TaskSearchField>(DEFAULT_FIELDS)

function parseBoolean(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes"
}

function parseTaskFields(value: string | null): TaskSearchField[] {
  if (!value) return DEFAULT_FIELDS

  const fields = value
    .split(",")
    .map((field) => field.trim() as TaskSearchField)
    .filter((field) => VALID_FIELDS.has(field))

  return fields.length > 0 ? fields : DEFAULT_FIELDS
}

export const GET: APIRoute = async ({ url }) => {
  const rawLimit = url.searchParams.get("limit")
  const parsedLimit = Number(rawLimit ?? 8)
  if ((rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) || !Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
    return apiProblem({
      status: 400,
      detail: "The search limit must be a positive decimal integer.",
      invalidParams: [{ name: "query.limit", reason: "Use a decimal integer from 1 to 9007199254740991." }],
    })
  }

  try {
    await ensureSchema()

    const rawScope = (url.searchParams.get("scope") ?? "all") as SearchScope
    const rawSort = (url.searchParams.get("sort") ?? "relevance") as SearchSort
    const priority = url.searchParams.get("priority")
    const limit = Math.min(12, parsedLimit)

    const options: SearchQueryOptions = {
      query: url.searchParams.get("q")?.trim() ?? "",
      scope: VALID_SCOPES.has(rawScope) ? rawScope : "all",
      limit,
      includeCompleted: parseBoolean(url.searchParams.get("include_completed")),
      includeArchived: parseBoolean(url.searchParams.get("include_archived")),
      sort: VALID_SORTS.has(rawSort) ? rawSort : "relevance",
      taskFields: parseTaskFields(url.searchParams.get("task_fields")),
    }
    const status = url.searchParams.get("status")?.trim()
    const assignedTo = url.searchParams.get("assigned_to")?.trim()
    const parsedPriority = priority == null
      ? undefined
      : Math.min(5, Math.max(1, Number(priority) || 0)) || undefined

    if (status) options.status = status
    if (assignedTo) options.assignedTo = assignedTo
    if (parsedPriority != null) options.priority = parsedPriority

    const result = await searchMeithealCatalog(options)
    return apiJson(result)
  } catch (error) {
    logApiError("search", "GET error", error)
    return apiError("Failed to search Meitheal", 500)
  }
}
