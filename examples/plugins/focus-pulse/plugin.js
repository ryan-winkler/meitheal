MeithealPlugin.onInit(async (api) => {
  await api.registerHeaderButton({
    id: "focus-pulse-open",
    label: "Focus Pulse",
    icon: "activity-heartbeat",
    onClick: () => api.openSidePanel(),
  })
})

MeithealPlugin.onMessage(async (msg, api) => {
  if (!msg || typeof msg !== "object") return { ok: false }
  if (msg.type === "load") {
    const tasks = await api.getTasks({ limit: 100 })
    const open = tasks.filter((t) => t.status !== "complete" && t.status !== "done").length
    const done = tasks.length - open
    const intention = (await api.storage.get("daily_intention")) || ""
    return { ok: true, open, done, intention }
  }
  if (msg.type === "save_intention") {
    const val = String(msg.value || "").slice(0, 140)
    await api.storage.set("daily_intention", val)
    await api.showToast({ message: "Daily intention saved", type: "success" })
    return { ok: true }
  }
  return { ok: false }
})
