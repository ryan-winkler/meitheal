/**
 * Generate a human-readable filename timestamp.
 * Format: "2026-03-01_16-47" (date + time, filesystem-safe)
 *
 * @domain infrastructure (shared utility)
 */
export function exportTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

/**
 * Build an export filename with a human-readable format.
 * Example: "Meitheal Settings - 2026-03-01_16-47.json"
 * Note: Uses ASCII hyphen (not em dash) for HTTP header compatibility.
 */
export function exportFilename(label: string, ext: string): string {
  return `Meitheal ${label} - ${exportTimestamp()}.${ext}`;
}
