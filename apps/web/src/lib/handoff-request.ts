import { readWithinLimit } from "./bounded-body"

export async function readHandoffRequest(request: Request): Promise<unknown> {
  const limit = 48 * 1024
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || Number(request.headers.get("content-length")) > limit) return null
  try {
    const bytes = await readWithinLimit(request.body, limit, AbortSignal.any([request.signal, AbortSignal.timeout(5000)]))
    return bytes ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null
  } catch {
    return null
  }
}
