MeithealPlugin.onInit(async (api) => {
  await api.registerHeaderButton({
    id: "carryover-open",
    label: "Carryover",
    icon: "history",
    onClick: () => api.openSidePanel(),
  })
})

const PRIORITY_LABELS = { 1: "Critical", 2: "High", 3: "Medium", 4: "Low", 5: "Minimal" }

function dueTimestamp(task) {
  if (!task || !task.dueDate) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(String(task.dueDate))
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function sortCarryover(items, sortBy) {
  const mode = sortBy === "priority" ? "priority" : "due_date"
  return items.slice().sort((a, b) => {
    const pA = typeof a.priority === "number" ? a.priority : 3
    const pB = typeof b.priority === "number" ? b.priority : 3
    const dA = dueTimestamp(a)
    const dB = dueTimestamp(b)
    if (mode === "priority") {
      if (pA !== pB) return pA - pB
      if (dA !== dB) return dA - dB
    } else {
      if (dA !== dB) return dA - dB
      if (pA !== pB) return pA - pB
    }
    return String(a.title || "").localeCompare(String(b.title || ""))
  })
}

MeithealPlugin.onMessage(async (msg, api) => {
  if (!msg || typeof msg !== "object") return { ok: false }
  if (msg.type === "load") {
    const today = new Date().toISOString().slice(0, 10)
    const sortBy = msg.sortBy === "priority" ? "priority" : "due_date"
    const tasks = await api.getTasks({ limit: 80 })
    const candidates = tasks.filter(
      (t) =>
        t.status !== "complete" &&
        t.status !== "done" &&
        (!t.dueDate || String(t.dueDate).slice(0, 10) < today),
    )
    const sorted = sortCarryover(candidates, sortBy).slice(0, 25).map((t) => ({
      ...t,
      priority: typeof t.priority === "number" ? t.priority : 3,
      priorityLabel: PRIORITY_LABELS[t.priority] || "Medium",
    }))
    return { ok: true, today, sortBy, items: sorted }
  }
  if (msg.type === "pull_today" && typeof msg.taskId === "string") {
    const today = new Date().toISOString().slice(0, 10)
    await api.updateTask(msg.taskId, { dueDate: today })
    await api.showToast({ message: "Task moved to Today", type: "success" })
    return { ok: true }
  }
  return { ok: false }
})
