import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

// Use the YAML parser already installed by the web workspace.
const { parse } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("yaml") as {
  parse: (source: string) => unknown
}

const docsRoot = fileURLToPath(new URL("../../docs/", import.meta.url))
const rootIndex = join(docsRoot, "index.md")
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const indexEntry = /^[-*] \[[^\]]+\]\(([^)\s]+)\) - \S/

test("the docs bundle has OKF 0.2 metadata and working indexes", () => {
  const files = new Set(
    readdirSync(docsRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
      .map(entry => join(entry.parentPath, entry.name))
      .sort(),
  )
  const indexedFiles = new Set<string>([rootIndex])
  const decoder = new TextDecoder("utf-8", { fatal: true })
  expect(files.has(rootIndex)).toBe(true)

  for (const file of files) {
    const name = relative(docsRoot, file)
    const source = decoder.decode(readFileSync(file))
    const header = frontmatter.exec(source)
    const metadata = header ? parse(header[1] ?? "") : undefined
    const lines = source.slice(header?.[0].length ?? 0).trim().split(/\r?\n/).filter(line => line.trim())

    switch (basename(file)) {
      case "index.md":
        expect(metadata, name).toEqual(file === rootIndex ? { okf_version: "0.2" } : undefined)
        expect(lines[0], name).toMatch(/^# \S/)
        for (const line of lines) {
          if (/^#+ \S/.test(line)) continue
          const entry = indexEntry.exec(line)
          expect(entry, name + " index entry").not.toBeNull()
          const target = resolve(dirname(file), decodeURIComponent(entry?.[1] ?? ""))
          expect(files.has(target), name + " links to " + relative(docsRoot, target)).toBe(true)
          indexedFiles.add(target)
        }
        break

      case "log.md": {
        expect(metadata, name).toBeUndefined()
        expect(lines[0], name).toMatch(/^# \S/)
        const entries = lines.slice(1)
        const dates = entries.filter(line => line.startsWith("## "))
        expect(entries[0], name).toMatch(/^## \d{4}-\d{2}-\d{2}$/)
        expect(entries.every(line => /^(?:## \d{4}-\d{2}-\d{2}|[-*] \S.*)$/.test(line)), name).toBe(true)
        expect(dates, name + " dates newest first").toEqual([...dates].sort().reverse())
        break
      }

      default:
        expect(metadata, name).toMatchObject({ type: expect.stringMatching(/\S/) })
    }
  }

  expect([...files].filter(file => !indexedFiles.has(file)).map(file => relative(docsRoot, file))).toEqual([])
})
