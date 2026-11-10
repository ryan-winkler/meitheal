import { formatDistanceToNow } from "date-fns";
import { format as tzFormat, toZonedTime } from "date-fns-tz";
import { createClientLogger } from "@lib/client-logger";

const log = createClientLogger("utils", "date");

export type DateFormat = "relative" | "absolute-iso" | "absolute-eu" | "absolute-us";

/**
 * Format a date string or Date object based on the user's regional settings.
 * Supports running in SSR (where settings are passed in) or CSR (reads from window.mSettings).
 */
export function formatRegionalDate(
  dateInput: string | Date | number | null | undefined,
  options?: {
    format?: DateFormat;
    timezone?: string;
    fallbackFormat?: string;
  }
): string {
  if (!dateInput) return "";

  // Resolve settings (Favor explicit options, then client-side window global, then defaults)
  let df: DateFormat = "relative";
  let tz = "Europe/Dublin";

  if (typeof window !== "undefined" && window.mSettings) {
    df = (window.mSettings.dateFormat as DateFormat) || "relative";
    tz = window.mSettings.timezone || "Europe/Dublin";
  }

  if (options?.format) df = options.format;
  if (options?.timezone) tz = options.timezone;

  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);

    // If explicit fallback was requested, use date-fns-tz
    if (options?.fallbackFormat) {
      const zoned = toZonedTime(d, tz);
      return tzFormat(zoned, options.fallbackFormat, { timeZone: tz });
    }

    if (df === "relative") {
      // e.g "2 days ago"
      return formatDistanceToNow(d, { addSuffix: true });
    }

    // Convert to zoned time
    const zonedDate = toZonedTime(d, tz);

    if (df === "absolute-iso") {
      return tzFormat(zonedDate, "yyyy-MM-dd", { timeZone: tz });
    }
    if (df === "absolute-eu") {
      return tzFormat(zonedDate, "dd/MM/yyyy", { timeZone: tz });
    }
    if (df === "absolute-us") {
      return tzFormat(zonedDate, "MM/dd/yyyy", { timeZone: tz });
    }

    // Default fallback
    return tzFormat(zonedDate, "yyyy-MM-dd", { timeZone: tz });
  } catch (e) {
    log.warn("Date formatting error", e);
    return String(dateInput);
  }
}
