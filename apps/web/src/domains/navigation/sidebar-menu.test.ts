import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_SECTION_IDS,
  TASK_VIEW_ITEM_KEYS,
  findItemSection,
  flattenSidebarOrder,
  isItemHidden,
  isSectionHidden,
  moveItemByStep,
  moveItemToSection,
  moveSectionByStep,
  normalizeSidebarConfig,
  pinCustomItem,
  renameItem,
  renameSection,
  reorderItem,
  reorderSections,
  serializeSidebarConfig,
  setItemVisible,
  toggleItemVisibility,
  toggleSectionVisibility,
  unpinCustomItem,
} from "./sidebar-menu"
import {
  normalizeUserProfile,
  profileInitials,
  profileSubtitle,
  validateUserProfile,
} from "../auth/user-profile"

const TEST_KEYS = [
  "dashboard",
  "today",
  "upcoming",
  "tasks",
  ...TASK_VIEW_ITEM_KEYS,
  "system-pinned",
  "progress",
  "planning",
  "boards",
  "settings",
]

test("normalizeSidebarConfig migrates legacy flat sidebar_config into sections and default-hides nested task views", () => {
  const legacy = {
    dashboard: true,
    today: false,
    upcoming: true,
    tasks: true,
    progress: true,
    planning: true,
    boards: true,
    order: ["tasks", "dashboard", "today", "planning", "boards"],
    labels: { tasks: "Chores" },
    customItems: [{ id: "custom-1", label: "Groceries", href: "/groceries", icon: "link" }],
  }

  const config = normalizeSidebarConfig(legacy, TEST_KEYS)

  assert.deepEqual(config.sectionOrder, [...DEFAULT_SECTION_IDS])
  assert.equal(isItemHidden(config, "today"), true)
  assert.equal(isItemHidden(config, "dashboard"), false)
  // Nested task views start hidden until pinned
  assert.equal(isItemHidden(config, "view-calendar"), true)
  assert.equal(isItemHidden(config, "view-kanban"), true)
  assert.equal(config.itemLabels.tasks, "Chores")
  assert.equal(config.itemLabels["custom-1"], "Groceries")
  assert.deepEqual(config.sectionItems.workspace.slice(0, 3), ["tasks", "dashboard", "today"])
  assert.ok(config.sectionItems.workspace.includes("custom-1"))
  assert.deepEqual(config.sectionItems.system, ["settings"])
})

test("pinned nested views and boards are independent of parents and movable across sections", () => {
  let config = normalizeSidebarConfig(null, TEST_KEYS)

  // Pin Calendar and hide Tasks parent -> Calendar remains visible and movable
  config = setItemVisible(config, "view-calendar", true)
  config = setItemVisible(config, "tasks", false)
  assert.equal(isItemHidden(config, "view-calendar"), false)
  assert.equal(isItemHidden(config, "tasks"), true)

  // Move Calendar into Planning section before Planning
  config = reorderItem(config, "view-calendar", "planning", false)
  assert.equal(findItemSection(config, "view-calendar"), "planning")
  assert.equal(
    config.sectionItems.planning.indexOf("view-calendar"),
    config.sectionItems.planning.indexOf("planning") - 1,
  )

  // Pin a nested Named Board independently of Boards parent and move it to Workspace
  config = pinCustomItem(config, {
    id: "board-household",
    label: "Household",
    href: "/boards/household",
    icon: "layout-kanban",
  }, "boards")
  config = setItemVisible(config, "boards", false)
  assert.equal(isItemHidden(config, "board-household"), false)
  assert.equal(isItemHidden(config, "boards"), true)
  config = moveItemToSection(config, "board-household", "workspace")
  assert.equal(findItemSection(config, "board-household"), "workspace")

  // Round-trip serialization preserves pinned nested items & their new sections
  const restored = normalizeSidebarConfig(serializeSidebarConfig(config), TEST_KEYS)
  assert.equal(isItemHidden(restored, "view-calendar"), false)
  assert.equal(isItemHidden(restored, "tasks"), true)
  assert.equal(findItemSection(restored, "view-calendar"), "planning")
  assert.equal(findItemSection(restored, "board-household"), "workspace")
  assert.equal(isItemHidden(restored, "board-household"), false)

  // Unpin removes the dynamic pinned board cleanly
  const unpinned = unpinCustomItem(restored, "board-household")
  assert.equal(findItemSection(unpinned, "board-household"), null)
  assert.equal(unpinned.customItems.some(item => item.id === "board-household"), false)
})

test("section and item visibility, renaming, and reordering round-trip through serializeSidebarConfig", () => {
  let config = normalizeSidebarConfig(null, TEST_KEYS)

  config = toggleSectionVisibility(config, "planning")
  assert.equal(isSectionHidden(config, "planning"), true)

  config = renameSection(config, "workspace", "Daily Flow")
  assert.equal(config.sectionLabels.workspace, "Daily Flow")

  config = reorderSections(config, "system", "workspace", false)
  assert.equal(config.sectionOrder[0], "system")

  config = moveSectionByStep(config, "system", 1)
  assert.equal(config.sectionOrder[1], "system")

  config = toggleItemVisibility(config, "upcoming")
  assert.equal(isItemHidden(config, "upcoming"), true)

  config = renameItem(config, "dashboard", "Home Base")
  assert.equal(config.itemLabels.dashboard, "Home Base")

  config = reorderItem(config, "planning", "today", true)
  assert.ok(config.sectionItems.workspace.includes("planning"))
  assert.equal(
    config.sectionItems.workspace.indexOf("planning"),
    config.sectionItems.workspace.indexOf("today") + 1,
  )

  config = moveItemByStep(config, "planning", -1)
  assert.equal(
    config.sectionItems.workspace.indexOf("planning"),
    config.sectionItems.workspace.indexOf("today") - 1,
  )

  config = moveItemToSection(config, "progress", "boards")
  assert.ok(config.sectionItems.boards.includes("progress"))

  const serialized = serializeSidebarConfig(config)
  assert.equal(serialized.upcoming, false)
  assert.equal(serialized.dashboard, true)
  assert.deepEqual(serialized.order, flattenSidebarOrder(config))

  const restored = normalizeSidebarConfig(JSON.stringify(JSON.stringify(serialized)), TEST_KEYS)
  assert.deepEqual(restored.sectionOrder, config.sectionOrder)
  assert.deepEqual(restored.hiddenSections, config.hiddenSections)
  assert.deepEqual(restored.sectionLabels, config.sectionLabels)
  assert.deepEqual(restored.sectionItems, config.sectionItems)
  assert.deepEqual(restored.hiddenItems, config.hiddenItems)
  assert.deepEqual(restored.itemLabels, config.itemLabels)
})

test("user profile domain normalizes, validates, and derives initials", () => {
  const defaulted = normalizeUserProfile(null, { displayName: "Ryan Winkler", username: "winks" })
  assert.equal(defaulted.displayName, "Ryan Winkler")
  assert.equal(defaulted.username, "winks")
  assert.equal(profileInitials(defaulted), "RW")
  assert.equal(profileSubtitle(defaulted), "winks")

  const invalid = validateUserProfile({ displayName: "   ", avatarColor: "#0ea5e9" })
  assert.equal(invalid.ok, false)

  const badColor = validateUserProfile({ displayName: "Ryan", avatarColor: "blue" })
  assert.equal(badColor.ok, false)

  const valid = validateUserProfile({
    displayName: "Ryan Winkler",
    username: "@winks",
    role: "Household Admin",
    avatarColor: "#10b981",
  })
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.equal(valid.profile.username, "winks")
    assert.equal(profileSubtitle(valid.profile), "Household Admin")
    assert.equal(profileInitials(valid.profile), "RW")
  }
})
