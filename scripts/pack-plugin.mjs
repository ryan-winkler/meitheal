#!/usr/bin/env node
/**
 * Zero-dependency Meitheal Plugin ZIP Packager
 *
 * Packages a plugin source directory (containing manifest.json and its declared
 * entry/iFrame/icon files) into a validated ZIP archive ready to upload in
 * Settings -> Plugins.
 *
 * Usage:
 *   node scripts/pack-plugin.mjs <plugin-dir> [--out <output.zip>]
 */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { deflateRawSync } from "node:zlib"

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const SAFE_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i
const SAFE_REL_FILE_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8")
    const dataBuf = entry.content
    const compressed = deflateRawSync(dataBuf, { level: 9 })
    const useDeflate = compressed.length < dataBuf.length
    const body = useDeflate ? compressed : dataBuf
    const method = useDeflate ? 8 : 0
    const crc = crc32(dataBuf)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    localParts.push(local, body)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centralParts.push(central)

    offset += local.length + body.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralBuf, eocd])
}

function assertSafeMember(rootDir, relPath) {
  if (typeof relPath !== "string" || !SAFE_REL_FILE_RE.test(relPath) || relPath.includes("..")) {
    throw new Error(`Unsafe manifest file reference: "${String(relPath)}"`)
  }
  const abs = resolve(rootDir, relPath)
  const rel = relative(rootDir, abs)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`File escapes plugin directory: "${relPath}"`)
  }
  const stat = lstatSync(abs)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Plugin file must be a regular file (no symlinks): "${relPath}"`)
  }
  return { name: relPath, content: readFileSync(abs) }
}

function main() {
  const args = process.argv.slice(2)
  const dirArg = args.find((a) => !a.startsWith("-"))
  if (!dirArg) {
    console.error("Usage: node scripts/pack-plugin.mjs <plugin-dir> [--out <output.zip>]")
    process.exit(1)
  }

  const outIdx = args.indexOf("--out")
  const outArg = outIdx >= 0 ? args[outIdx + 1] : null

  const rootDir = resolve(process.cwd(), dirArg)
  const dirStat = lstatSync(rootDir)
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`Not a valid plugin directory: ${rootDir}`)
  }

  const manifestEntry = assertSafeMember(rootDir, "manifest.json")
  const manifest = JSON.parse(manifestEntry.content.toString("utf8"))
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest.json must be a JSON object")
  }
  if (!SAFE_ID_RE.test(String(manifest.id ?? ""))) {
    throw new Error(`Invalid plugin id in manifest.json: "${String(manifest.id ?? "")}"`)
  }
  if (!SAFE_SEMVER_RE.test(String(manifest.version ?? ""))) {
    throw new Error(`Invalid plugin version in manifest.json: "${String(manifest.version ?? "")}"`)
  }

  const entries = [manifestEntry]
  const seen = new Set(["manifest.json"])
  for (const field of ["entry", "iFrame", "icon"]) {
    if (typeof manifest[field] === "string" && manifest[field].trim()) {
      const rel = manifest[field].trim()
      if (!seen.has(rel)) {
        entries.push(assertSafeMember(rootDir, rel))
        seen.add(rel)
      }
    }
  }

  const zip = buildZip(entries)
  if (zip.length > 2 * 1024 * 1024) {
    throw new Error(`Packed ZIP exceeds 2 MB limit (${zip.length} bytes)`)
  }

  const outPath = outArg
    ? resolve(process.cwd(), outArg)
    : resolve(dirname(rootDir), `${manifest.id}-v${manifest.version}.zip`)
  if (existsSync(outPath) && lstatSync(outPath).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink output path: ${outPath}`)
  }
  writeFileSync(outPath, zip)

  const sha256 = createHash("sha256").update(zip).digest("hex")
  console.log(
    JSON.stringify({
      packed: true,
      id: manifest.id,
      version: manifest.version,
      files: entries.map((e) => e.name),
      bytes: zip.length,
      sha256,
      output: outPath,
    }),
  )
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
