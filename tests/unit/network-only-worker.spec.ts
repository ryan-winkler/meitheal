import { expect, test } from "@playwright/test"
import { workerAllowsNetworkOnly } from "../../apps/web/src/lib/network-only-worker"

const capability = "MEITHEAL_PRESETS_NETWORK_ONLY"

async function checkWorker(replies: Array<boolean | undefined>, retryTimeoutMs?: number) {
  const deadlines: number[] = []
  const probes: string[] = []
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void, deadline: number) {
        const noReply = replies[deadlines.length] === undefined
        deadlines.push(deadline)
        return setTimeout(callback, noReply ? 0 : deadline)
      },
      clearTimeout,
    },
  })
  const worker = {
    postMessage(message: { type: string }, [port]: [MessagePort]) {
      probes.push(message.type)
      const reply = replies[probes.length - 1]
      if (reply !== undefined) port.postMessage(reply)
      port.close()
    },
  } as unknown as ServiceWorker
  try {
    const allowed = await workerAllowsNetworkOnly(worker, capability, retryTimeoutMs)
    return { allowed, deadlines, probes }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("an opted-in worker probe retries a missing response and requires an explicit confirmation", async () => {
  expect(await checkWorker([undefined, true], 1_500)).toEqual({
    allowed: true, deadlines: [500, 1_500], probes: [capability, capability],
  })
  expect(await checkWorker([undefined, undefined], 1_500)).toEqual({
    allowed: false, deadlines: [500, 1_500], probes: [capability, capability],
  })
})

test("an explicit denial or an unmodified caller uses only the first deadline", async () => {
  expect(await checkWorker([false], 1_500)).toEqual({
    allowed: false, deadlines: [500], probes: [capability],
  })
  expect(await checkWorker([undefined])).toEqual({
    allowed: false, deadlines: [500], probes: [capability],
  })
})
