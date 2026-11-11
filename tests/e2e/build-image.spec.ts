import { execFile } from "node:child_process"
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL("../../", import.meta.url))

test("normal image command selects the host guard, preserves arguments and never bypasses guard failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-build-entry-"))
  const guard = join(directory, "meitheal-build")
  const engineReceipt = join(directory, "podman.args")
  const guardReceipt = join(directory, "guard.args")
  const fake = (receipt: string, code: number) => `#!/bin/bash\nprintf '%s\\0' "$@" > ${JSON.stringify(receipt)}\nexit ${code}\n`
  try {
    await writeFile(join(directory, "podman"), fake(engineReceipt, 0))
    await chmod(join(directory, "podman"), 0o755)
    const args = ["--tag", "localhost/meitheal:fixture with spaces", "--build-arg", "NOTE=literal $value"]
    const { stdout } = await execFileAsync("/bin/sh", ["-c", "command -v npm"])
    const npm = stdout.trim()
    await symlink(process.execPath, join(directory, "node"))
    const options = { cwd: root, env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` } }
    const expected = ["build", "--format", "docker", "--file", join(root, "meitheal-hub/Dockerfile"), ...args, root.replace(/\/$/, "")]
    const receipt = async (path: string) => (await readFile(path, "utf8")).split("\0").filter(Boolean)

    await writeFile(guard, fake(guardReceipt, 0))
    await chmod(guard, 0o755)
    await execFileAsync(npm, ["run", "build:image", "--", ...args], options)
    expect(await receipt(guardReceipt)).toEqual(["podman", ...expected])
    await expect(access(engineReceipt)).rejects.toThrow()

    await writeFile(guard, fake(guardReceipt, 42))
    await expect(execFileAsync(npm, ["run", "build:image", "--", ...args], options)).rejects.toMatchObject({ code: 42 })
    await expect(access(engineReceipt)).rejects.toThrow()

    await rm(guard)
    await execFileAsync(npm, ["run", "build:image", "--", ...args], options)
    expect(await receipt(engineReceipt)).toEqual(expected)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
