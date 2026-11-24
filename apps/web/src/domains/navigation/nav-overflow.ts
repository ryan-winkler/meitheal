/**
 * Pure Tabler nav-overflow layout packer.
 * Keeps items filling the available horizontal bar width cleanly before
 * moving remaining destinations into the "More" overflow menu.
 *
 * @domain navigation
 */

export interface NavOverflowItem {
  id: string
  width: number
  groupIndex: number
  priority?: boolean
}

export interface NavOverflowLayoutInput {
  items: readonly NavOverflowItem[]
  groupGaps: readonly number[]
  availableWidth: number
  fixedWidth: number
  fixedCount: number
  moreWidth: number
  containerGap: number
}

export interface NavOverflowLayoutResult {
  visibleIds: Set<string>
  overflowIds: string[]
  showMore: boolean
  overflowHasPriority: boolean
}

export function measureNavOverflowWidth(
  input: NavOverflowLayoutInput,
  selectedIds: ReadonlySet<string>,
  showMore: boolean,
): number {
  let width = input.fixedWidth + (showMore ? input.moreWidth : 0)
  let groups = input.fixedCount + (showMore ? 1 : 0)
  const groupCount = input.groupGaps.length

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    let itemCount = 0
    let itemWidth = 0
    for (const item of input.items) {
      if (item.groupIndex !== groupIndex || !selectedIds.has(item.id)) continue
      itemCount += 1
      itemWidth += Math.max(0, item.width)
    }
    if (itemCount === 0) continue
    groups += 1
    width += itemWidth + (input.groupGaps[groupIndex] ?? 0) * (itemCount - 1)
  }

  return width + Math.max(0, input.containerGap) * Math.max(0, groups - 1)
}

export function computeNavOverflow(input: NavOverflowLayoutInput): NavOverflowLayoutResult {
  const allIds = new Set(input.items.map(item => item.id))
  if (input.items.length === 0) {
    return { visibleIds: allIds, overflowIds: [], showMore: false, overflowHasPriority: false }
  }

  const budget = Math.max(0, input.availableWidth) + 0.5
  if (measureNavOverflowWidth(input, allIds, false) <= budget) {
    return { visibleIds: allIds, overflowIds: [], showMore: false, overflowHasPriority: false }
  }

  const visibleIds = new Set<string>()
  const tryKeep = (id: string): boolean => {
    if (visibleIds.has(id)) return true
    visibleIds.add(id)
    if (measureNavOverflowWidth(input, visibleIds, true) <= budget) return true
    visibleIds.delete(id)
    return false
  }

  // Reserve priority items (active route or focused item) first when they fit.
  for (const item of input.items) {
    if (item.priority) tryKeep(item.id)
  }

  // Greedily fill remaining horizontal space in natural left-to-right order.
  for (const item of input.items) {
    if (visibleIds.has(item.id)) continue
    if (!tryKeep(item.id)) break
  }

  const overflowIds: string[] = []
  let overflowHasPriority = false
  for (const item of input.items) {
    if (!visibleIds.has(item.id)) {
      overflowIds.push(item.id)
      if (item.priority) overflowHasPriority = true
    }
  }

  return {
    visibleIds,
    overflowIds,
    showMore: overflowIds.length > 0,
    overflowHasPriority,
  }
}
