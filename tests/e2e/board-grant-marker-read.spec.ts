import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "@playwright/test"
import { readBoardGrantRevision } from "../../apps/web/scripts/board-grant-journal.mjs"

const first = "11111111-1111-4111-8111-111111111111"
const second = "22222222-2222-4222-8222-222222222222"
const third = "33333333-3333-4333-8333-333333333333"
const marker = (epoch: string) => JSON.stringify({ epoch })

test("marker reads follow publication, in-place changes, removal and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-grant-marker-"))
  const path = join(directory, "meitheal-board-grants.json")
  try {
    await writeFile(path, marker(first))
    expect(await readBoardGrantRevision(path)).toBe(first)
    // Let the file settle so its parsed epoch may be reused.
    await delay(1_100)
    expect(await readBoardGrantRevision(path)).toBe(first)
    expect(await readBoardGrantRevision(path)).toBe(first)

    // Same-size in-place rewrite of a settled marker.
    await writeFile(path, marker(second))
    expect(await readBoardGrantRevision(path)).toBe(second)
    await writeFile(path, marker(first))
    expect(await readBoardGrantRevision(path)).toBe(first)

    // Publication renames a prepared file over the marker.
    await delay(1_100)
    expect(await readBoardGrantRevision(path)).toBe(first)
    const pending = join(directory, "pending.json")
    await writeFile(pending, marker(third))
    await rename(pending, path)
    expect(await readBoardGrantRevision(path)).toBe(third)

    await writeFile(path, "{\"epoch\":\"not-a-revision\"}")
    expect(await readBoardGrantRevision(path)).toBeNull()

    await rm(path)
    expect(await readBoardGrantRevision(path)).toBeNull()

    const target = join(directory, "target.json")
    await writeFile(target, marker(first))
    await symlink(target, path)
    expect(await readBoardGrantRevision(path)).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
