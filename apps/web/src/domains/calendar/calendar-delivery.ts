// One HA writer per task and destination in the application process. Keep the
// slot through receipt persistence, so a waiting reminder can see the result.
const writers = new Map<string, Promise<boolean>>()

export async function serializeCalendarDelivery(taskId: string, entity: string,
  deliver: (waited: boolean) => Promise<boolean>): Promise<boolean> {
  const key = JSON.stringify([taskId, entity])
  const previous = writers.get(key)
  const current = (previous ?? Promise.resolve(false)).catch(() => false).then(() => deliver(previous !== undefined))
  writers.set(key, current)
  try { return await current } finally {
    if (writers.get(key) === current) writers.delete(key)
  }
}
