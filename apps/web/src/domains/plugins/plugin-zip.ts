/**
 * Hardened Zero-Dependency Plugin ZIP Archive Parser
 *
 * Parses standard PKZIP archives using Node's built-in `node:zlib` and enforces
 * ADR 0028 security caps:
 *   - <= 2 MB compressed archive
 *   - <= 8 MB total uncompressed output
 *   - <= 50 files
 *   - <= 20:1 compression ratio (zip-bomb defense)
 *   - Zip Slip, absolute path, backslash, NUL byte, and symlink rejection
 *   - Strict file extension allowlist
 *
 * @domain plugins
 * @bounded-context plugins
 */
import { createHash } from "node:crypto"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import type { PluginResult } from "./types"

export const MAX_ZIP_COMPRESSED_BYTES = 2 * 1024 * 1024 // 2 MB
export const MAX_ZIP_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 // 8 MB
export const MAX_ZIP_FILES = 50
export const MAX_ZIP_COMPRESSION_RATIO = 20

const ALLOWED_EXTENSIONS = new Set([
  ".json",
  ".js",
  ".mjs",
  ".html",
  ".css",
  ".svg",
  ".png",
  ".webp",
  ".txt",
  ".md",
])

const EOCD_SIGNATURE = 0x06054b50
const CD_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const UNIX_SYMLINK_MODE = 0o120000
const UNIX_FILETYPE_MASK = 0o170000

export interface ExtractedPluginArchive {
  files: Map<string, Buffer>
  sha256: string
  totalUncompressedBytes: number
}

function fail(errorCode: string, error: string): PluginResult<never> {
  return { ok: false, errorCode, error, status: 400 }
}

function getExtension(filePath: string): string {
  const slash = filePath.lastIndexOf("/")
  const base = slash === -1 ? filePath : filePath.slice(slash + 1)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot).toLowerCase()
}

function isSafeEntryPath(rawPath: string): boolean {
  if (!rawPath || rawPath.length > 240) return false
  if (rawPath.includes("\0") || rawPath.includes("\\")) return false
  if (rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)) return false
  const parts = rawPath.split("/")
  for (const part of parts) {
    if (!part || part === "." || part === "..") return false
    if (part === ".git" || part === "__MACOSX" || part === ".DS_Store") return false
  }
  return true
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 22 - 65535)
  for (let offset = buf.length - 22; offset >= minOffset; offset--) {
    if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset
    }
  }
  return -1
}

export function extractPluginZip(zipBuffer: Buffer): PluginResult<ExtractedPluginArchive> {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
    return fail("INVALID_ARCHIVE", "Uploaded file is not a valid ZIP archive.")
  }
  if (zipBuffer.length > MAX_ZIP_COMPRESSED_BYTES) {
    return fail("ARCHIVE_TOO_LARGE", "Plugin ZIP archive exceeds the 2 MB compressed size limit.")
  }

  const eocdOffset = findEndOfCentralDirectory(zipBuffer)
  if (eocdOffset === -1) {
    return fail("INVALID_ARCHIVE", "ZIP archive is missing its central directory.")
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10)
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12)
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16)

  if (totalEntries === 0) {
    return fail("EMPTY_ARCHIVE", "Plugin ZIP archive contains no files.")
  }
  if (totalEntries > MAX_ZIP_FILES * 2) {
    return fail("TOO_MANY_FILES", `Plugin ZIP archive exceeds the ${MAX_ZIP_FILES}-file limit.`)
  }
  if (cdOffset + cdSize > eocdOffset) {
    return fail("INVALID_ARCHIVE", "ZIP central directory bounds are corrupted.")
  }

  const rawFiles = new Map<string, Buffer>()
  let cursor = cdOffset
  let totalUncompressedBytes = 0

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > cdOffset + cdSize) {
      return fail("INVALID_ARCHIVE", "ZIP central directory entry is truncated.")
    }
    if (zipBuffer.readUInt32LE(cursor) !== CD_SIGNATURE) {
      return fail("INVALID_ARCHIVE", "Invalid ZIP central directory signature.")
    }

    const versionMadeBy = zipBuffer.readUInt16LE(cursor + 4)
    const flags = zipBuffer.readUInt16LE(cursor + 8)
    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10)
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24)
    const nameLen = zipBuffer.readUInt16LE(cursor + 28)
    const extraLen = zipBuffer.readUInt16LE(cursor + 30)
    const commentLen = zipBuffer.readUInt16LE(cursor + 32)
    const externalAttr = zipBuffer.readUInt32LE(cursor + 38)
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42)

    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLen
    if (nameEnd > cdOffset + cdSize) {
      return fail("INVALID_ARCHIVE", "ZIP entry filename is truncated.")
    }

    const entryName = zipBuffer.subarray(nameStart, nameEnd).toString("utf8")
    cursor = nameEnd + extraLen + commentLen

    // Reject encrypted entries
    if ((flags & 0x0001) !== 0) {
      return fail("ENCRYPTED_ARCHIVE", "Encrypted ZIP archives are not supported.")
    }

    // Reject Unix symbolic links
    const hostOs = versionMadeBy >> 8
    const unixMode = (externalAttr >>> 16) & 0xffff
    if (hostOs === 3 && (unixMode & UNIX_FILETYPE_MASK) === UNIX_SYMLINK_MODE) {
      return fail("INVALID_ARCHIVE_PATH", `Symbolic links are forbidden in plugin archives ("${entryName}").`)
    }

    // Ignore macOS metadata folders and pure directory entries
    if (entryName.startsWith("__MACOSX/") || entryName.endsWith("/")) {
      continue
    }

    if (!isSafeEntryPath(entryName)) {
      return fail("INVALID_ARCHIVE_PATH", `Unsafe path "${entryName}" in ZIP archive.`)
    }

    const ext = getExtension(entryName)
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return fail("DISALLOWED_FILE_TYPE", `File type "${ext || "(none)"}" is not permitted ("${entryName}").`)
    }

    if (rawFiles.size >= MAX_ZIP_FILES) {
      return fail("TOO_MANY_FILES", `Plugin ZIP archive exceeds the ${MAX_ZIP_FILES}-file limit.`)
    }

    if (uncompressedSize > MAX_ZIP_UNCOMPRESSED_BYTES) {
      return fail("ARCHIVE_TOO_LARGE", "Plugin ZIP archive exceeds the 8 MB uncompressed size limit.")
    }

    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_ZIP_COMPRESSION_RATIO && uncompressedSize > 16384) {
      return fail("ZIP_BOMB_DETECTED", `Entry "${entryName}" exceeds the ${MAX_ZIP_COMPRESSION_RATIO}:1 compression ratio cap.`)
    }

    if (localHeaderOffset + 30 > zipBuffer.length) {
      return fail("INVALID_ARCHIVE", "ZIP local file header offset is out of bounds.")
    }
    if (zipBuffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
      return fail("INVALID_ARCHIVE", "Invalid ZIP local file header signature.")
    }

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + compressedSize

    if (dataEnd > zipBuffer.length) {
      return fail("INVALID_ARCHIVE", "ZIP entry data is out of bounds.")
    }

    const rawSlice = zipBuffer.subarray(dataStart, dataEnd)
    let fileBytes: Buffer
    if (compressionMethod === 0) {
      fileBytes = Buffer.from(rawSlice)
    } else if (compressionMethod === 8) {
      try {
        fileBytes = inflateRawSync(rawSlice, { maxOutputLength: MAX_ZIP_UNCOMPRESSED_BYTES + 1 })
      } catch {
        return fail("ARCHIVE_TOO_LARGE", `Failed to inflate "${entryName}" safely within size limits.`)
      }
    } else {
      return fail("UNSUPPORTED_COMPRESSION", `Unsupported ZIP compression method ${compressionMethod} for "${entryName}".`)
    }

    if (compressedSize > 0 && fileBytes.length / compressedSize > MAX_ZIP_COMPRESSION_RATIO && fileBytes.length > 16384) {
      return fail("ZIP_BOMB_DETECTED", `Inflated entry "${entryName}" exceeds the ${MAX_ZIP_COMPRESSION_RATIO}:1 compression ratio cap.`)
    }

    totalUncompressedBytes += fileBytes.length
    if (totalUncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
      return fail("ARCHIVE_TOO_LARGE", "Plugin ZIP archive exceeds the 8 MB total uncompressed size limit.")
    }

    rawFiles.set(entryName, fileBytes)
  }

  if (rawFiles.size === 0) {
    return fail("EMPTY_ARCHIVE", "Plugin ZIP archive contains no readable files.")
  }

  // Unwrap a single shared top-level directory if manifest.json lives inside it (e.g. my-plugin/manifest.json)
  let files = rawFiles
  if (!rawFiles.has("manifest.json")) {
    const firstSegments = new Set<string>()
    for (const key of rawFiles.keys()) {
      const slash = key.indexOf("/")
      if (slash === -1) {
        firstSegments.clear()
        break
      }
      firstSegments.add(key.slice(0, slash))
    }
    if (firstSegments.size === 1) {
      const prefix = `${[...firstSegments][0]}/`
      const unwrapped = new Map<string, Buffer>()
      for (const [key, val] of rawFiles.entries()) {
        unwrapped.set(key.slice(prefix.length), val)
      }
      files = unwrapped
    }
  }

  if (!files.has("manifest.json")) {
    return fail("MISSING_MANIFEST", "Plugin ZIP archive must include manifest.json at the archive root.")
  }

  const sha256 = createHash("sha256").update(zipBuffer).digest("hex")
  return {
    ok: true,
    data: {
      files,
      sha256,
      totalUncompressedBytes,
    },
  }
}

/**
 * Deterministic pure-Node PKZIP builder used by unit tests and smoke checks.
 */
export function buildPluginZip(
  entries: Array<{ name: string; content: Buffer | string; compress?: boolean; unixMode?: number }>,
): Buffer {
  const localParts: Buffer[] = []
  const cdParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8")
    const rawBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8")
    const useDeflate = entry.compress !== false
    const dataBuf = useDeflate ? deflateRawSync(rawBuf) : rawBuf
    const method = useDeflate ? 8 : 0
    const crc = crc32(rawBuf)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(rawBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)

    localParts.push(local, dataBuf)

    const cd = Buffer.alloc(46 + nameBuf.length)
    cd.writeUInt32LE(CD_SIGNATURE, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // Unix made-by
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc >>> 0, 16)
    cd.writeUInt32LE(dataBuf.length, 20)
    cd.writeUInt32LE(rawBuf.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    nameBuf.copy(cd, 46)

    cdParts.push(cd)
    offset += local.length + dataBuf.length
  }

  const cdBuf = Buffer.concat(cdParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, cdBuf, eocd])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
