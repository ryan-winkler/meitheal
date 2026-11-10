/**
 * Strips HTML tags from a string using DOMParser.
 *
 * DOMParser-based approach is more robust than regex against malformed HTML,
 * nested tags, and edge cases. Falls back to regex stripping for server-side
 * contexts where DOMParser may not be available.
 *
 * @domain tasks (shared utility — cross-domain safe)
 */

const TAG_RE = /<[^>]*>/g;

export function stripHtml(input: string): string {
  // Prefer DOMParser for robust sanitization (browser context)
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(input, "text/html");
      return doc.body.textContent ?? "";
    } catch {
      // Fallback to regex if DOMParser fails
    }
  }

  // Server-side fallback: recursive regex stripping
  let result = input;
  while (TAG_RE.test(result)) {
    TAG_RE.lastIndex = 0;
    result = result.replace(TAG_RE, "");
  }
  return result;
}
