/**
 * Filter Engine — Compound AND/OR Filter Logic
 * 
 * Supports nested filter groups and various operators for advanced querying.
 */

export type LogicOperator = "AND" | "OR"
export type FilterOperator = 
  | "equals" 
  | "notEquals" 
  | "contains" 
  | "notContains"
  | "greaterThan" 
  | "lessThan" 
  | "between" 
  | "isEmpty" 
  | "isNotEmpty"

export interface FilterCondition {
  id: string
  logic?: LogicOperator // How this condition joins with the accumulated result before it
  field: string
  operator: FilterOperator
  value: any
}

export interface FilterGroup {
  id: string
  logic: LogicOperator
  conditions: (FilterCondition | FilterGroup)[]
}

/**
 * Evaluates a single condition against a dataset (row attributes, etc.)
 */
function evaluateCondition(condition: FilterCondition, data: Record<string, any>): boolean {
  const { field, operator, value } = condition
  const dataValue = data[field]

  switch (operator) {
    case "equals":
      // Handle array intersections or exact matches
      if (Array.isArray(dataValue)) {
         return dataValue.includes(value)
      }
      return String(dataValue).toLowerCase() === String(value).toLowerCase()
    case "notEquals":
      if (Array.isArray(dataValue)) {
         return !dataValue.includes(value)
      }
      return String(dataValue).toLowerCase() !== String(value).toLowerCase()
    case "contains":
      if (Array.isArray(dataValue)) {
         return dataValue.some(v => String(v).toLowerCase().includes(String(value).toLowerCase()))
      }
      return String(dataValue).toLowerCase().includes(String(value).toLowerCase())
    case "notContains":
      if (Array.isArray(dataValue)) {
        return !dataValue.some(v => String(v).toLowerCase().includes(String(value).toLowerCase()))
      }
      return !String(dataValue).toLowerCase().includes(String(value).toLowerCase())
    case "greaterThan":
      return Number(dataValue) > Number(value)
    case "lessThan":
      return Number(dataValue) < Number(value)
    case "between":
      if (!Array.isArray(value) || value.length !== 2) return false
      return Number(dataValue) >= Number(value[0]) && Number(dataValue) <= Number(value[1])
    case "isEmpty":
      return dataValue === undefined || dataValue === null || dataValue === "" || (Array.isArray(dataValue) && dataValue.length === 0)
    case "isNotEmpty":
      return dataValue !== undefined && dataValue !== null && dataValue !== "" && (!Array.isArray(dataValue) || dataValue.length > 0)
    default:
      return false
  }
}

/**
 * Parses element dataset into a record suitable for condition evaluation
 */
export function extractDataFromElement(el: Pick<HTMLElement, "dataset">): Record<string, any> {
  const data: Record<string, any> = { ...el.dataset }
  // Special parsing for explicit typed fields
  if (data.labels) {
    try {
      const parsed = JSON.parse(data.labels)
      data.labels = parsed.map((l: any) => typeof l === 'string' ? l : l.name || '')
    } catch {
      data.labels = []
    }
  } else {
    data.labels = []
  }
  // Standardize taskType
  data.type = data.taskType || data.task_type || "task"
  return data
}

/**
 * Evaluates a nested filter group against a dataset
 */
export function evaluateFilterGroup(group: FilterGroup, data: Record<string, any>): boolean {
  if (!group.conditions || group.conditions.length === 0) {
    return true
  }

  // Base result is the evaluation of the first condition/group
  let result = evaluateNode(group.conditions[0]!, data)

  // Evaluate remaining nodes linearly left-to-right
  for (let i = 1; i < group.conditions.length; i++) {
    const node = group.conditions[i]!
    const nodeResult = evaluateNode(node, data)
    
    // Use node's logic if present (for linear per-condition logic), else fallback to group logic
    const op = ("logic" in node && node.logic) ? node.logic : group.logic

    if (op === "AND") {
      result = result && nodeResult
    } else {
      result = result || nodeResult
    }
  }

  return result
}

function evaluateNode(node: FilterCondition | FilterGroup, data: Record<string, any>): boolean {
  if ("conditions" in node) {
    return evaluateFilterGroup(node, data)
  } else {
    return evaluateCondition(node, data)
  }
}

/**
 * Main entry point: Check if an element passes the advanced filter group
 */
export function passesAdvancedFilter(el: HTMLElement, group: FilterGroup | null): boolean {
  if (!group || !group.conditions || group.conditions.length === 0) return true
  const data = extractDataFromElement(el)
  return evaluateFilterGroup(group, data)
}
