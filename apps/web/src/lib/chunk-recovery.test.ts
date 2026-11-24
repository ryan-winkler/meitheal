import assert from "node:assert/strict"
import test from "node:test"
import { attemptStaleChunkReload, extractErrorMessage, isStaleChunkError, type StorageLike } from "./chunk-recovery"

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

test("isStaleChunkError identifies Vite and browser dynamic import failures", () => {
  assert.equal(
    isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://app.example/node_modules/.vite/deps/astro-CdkklI4T.js?v=2cef5076")),
    true,
  )
  assert.equal(isStaleChunkError("Importing a module script failed."), true)
  assert.equal(isStaleChunkError({ message: "error loading dynamically imported module" }), true)
  assert.equal(isStaleChunkError(new Error("504 Outdated Optimize Dep")), true)
  assert.equal(isStaleChunkError(new Error("Network timeout")), false)
  assert.equal(isStaleChunkError(null), false)
})

test("extractErrorMessage handles Error, string, object, and unknown inputs", () => {
  assert.equal(extractErrorMessage(new Error("boom")), "boom")
  assert.equal(extractErrorMessage("plain"), "plain")
  assert.equal(extractErrorMessage({ message: "wrapped" }), "wrapped")
  assert.equal(extractErrorMessage(42), "")
})

test("attemptStaleChunkReload reloads once and suppresses repeats inside cooldown window", () => {
  const storage = createMemoryStorage()
  let reloads = 0
  const reload = () => {
    reloads += 1
  }

  assert.equal(attemptStaleChunkReload(storage, 10_000, reload, 15_000), true)
  assert.equal(reloads, 1)

  // Inside cooldown window -> blocked
  assert.equal(attemptStaleChunkReload(storage, 20_000, reload, 15_000), false)
  assert.equal(reloads, 1)

  // After cooldown expires -> allowed again
  assert.equal(attemptStaleChunkReload(storage, 26_000, reload, 15_000), true)
  assert.equal(reloads, 2)
})

test("attemptStaleChunkReload fails closed when storage throws", () => {
  const brokenStorage: StorageLike = {
    getItem() {
      throw new Error("SecurityError")
    },
    setItem() {
      throw new Error("SecurityError")
    },
  }
  let reloads = 0
  assert.equal(attemptStaleChunkReload(brokenStorage, 10_000, () => { reloads += 1 }), false)
  assert.equal(reloads, 0)
})
