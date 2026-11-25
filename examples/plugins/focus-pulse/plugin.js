MeithealPlugin.onInit(async (api) => {
  await api.registerHeaderButton({
    id: "focus-pulse-open",
    label: "Focus Pulse",
    icon: "activity-heartbeat",
    onClick: () => api.openSidePanel(),
  })
})

const PRIORITY_LABELS = { 1: "Critical", 2: "High", 3: "Medium", 4: "Low", 5: "Minimal" }

function normalizeSortBy(value) {
  return value === "due_date" ? "due_date" : "priority"
}

function dueTimestamp(task) {
  if (!task || !task.dueDate) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(String(task.dueDate))
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function sortTasks(tasks, sortBy) {
  const mode = normalizeSortBy(sortBy)
  return tasks.slice().sort((a, b) => {
    const pA = typeof a.priority === "number" ? a.priority : 3
    const pB = typeof b.priority === "number" ? b.priority : 3
    const dA = dueTimestamp(a)
    const dB = dueTimestamp(b)
    if (mode === "due_date") {
      if (dA !== dB) return dA - dB
      if (pA !== pB) return pA - pB
    } else {
      if (pA !== pB) return pA - pB
      if (dA !== dB) return dA - dB
    }
    return String(a.title || "").localeCompare(String(b.title || ""))
  })
}

MeithealPlugin.onMessage(async (msg, api) => {
  if (!msg || typeof msg !== "object") return { ok: false }
  if (msg.type === "load") {
    const tasks = await api.getTasks({ limit: 100 })
    const openTasks = tasks.filter((t) => t.status !== "complete" && t.status !== "done")
    const done = tasks.length - openTasks.length
    const storedSort = await api.storage.get("focus_sort_by")
    const sortBy = normalizeSortBy(msg.sortBy || storedSort)
    if (msg.sortBy && msg.sortBy !== storedSort) {
      await api.storage.set("focus_sort_by", sortBy)
    }
    const items = sortTasks(openTasks, sortBy).slice(0, 10).map((t) => ({
      id: t.id,
      title: t.title,
      priority: typeof t.priority === "number" ? t.priority : 3,
      priorityLabel: PRIORITY_LABELS[t.priority] || "Medium",
      dueDate: t.dueDate || null,
    }))
    const intention = (await api.storage.get("daily_intention")) || ""
    return { ok: true, open: openTasks.length, done, intention, sortBy, items }
  }
  if (msg.type === "save_intention") {
    const val = String(msg.value || "").slice(0, 140)
    await api.storage.set("daily_intention", val)
    await api.showToast({ message: "Daily intention saved", type: "success" })
    return { ok: true }
  }
  return { ok: false }
})
