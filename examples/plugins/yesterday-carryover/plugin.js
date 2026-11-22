MeithealPlugin.onInit(async (api) => {
  await api.registerHeaderButton({
    id: "carryover-open",
    label: "Carryover",
    icon: "history",
    onClick: () => api.openSidePanel(),
  })
})

MeithealPlugin.onMessage(async (msg, api) => {
  if (!msg || typeof msg !== "object") return { ok: false }
  if (msg.type === "load") {
    const today = new Date().toISOString().slice(0, 10)
    const tasks = await api.getTasks({ limit: 80 })
    const candidates = tasks.filter(
      (t) =>
        t.status !== "complete" &&
        t.status !== "done" &&
        (!t.dueDate || String(t.dueDate).slice(0, 10) < today),
    )
    return { ok: true, today, items: candidates.slice(0, 25) }
  }
  if (msg.type === "pull_today" && typeof msg.taskId === "string") {
    const today = new Date().toISOString().slice(0, 10)
    await api.updateTask(msg.taskId, { dueDate: today })
    await api.showToast({ message: "Task moved to Today", type: "success" })
    return { ok: true }
  }
  return { ok: false }
})
