/**
 * Recurrence Engine — Phase 31
 *
 * Parses iCal RRULE-style recurrence rules and calculates next occurrences.
 * Supports: DAILY, WEEKLY, MONTHLY, YEARLY frequencies with INTERVAL and BYDAY.
 *
 * @domain domain-tasks
 * @kcs Recurrence rules follow RFC 5545 RRULE subset
 */

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay?: string[]; // MO, TU, WE, TH, FR, SA, SU
  count?: number;
  until?: string; // ISO date string
}

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Parse an RRULE string into a structured RecurrenceRule.
 * Example: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR"
 */
export function parseRRule(rrule: string): RecurrenceRule | null {
  if (!rrule || rrule.trim().length === 0) return null;

  const raw = rrule.startsWith("RRULE:") ? rrule.slice(6) : rrule;
  const parts = raw.split(";");
  const map = new Map<string, string>();

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key && value) map.set(key.toUpperCase(), value.toUpperCase());
  }

  const freq = map.get("FREQ");
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    return null;
  }

  const rule: RecurrenceRule = {
    freq: freq as RecurrenceRule["freq"],
    interval: Math.max(1, parseInt(map.get("INTERVAL") ?? "1", 10) || 1),
  };

  const byDay = map.get("BYDAY");
  if (byDay) {
    rule.byDay = byDay.split(",").filter((d) => d in DAY_MAP);
  }

  const count = map.get("COUNT");
  if (count) {
    rule.count = parseInt(count, 10);
  }

  const until = map.get("UNTIL");
  if (until) {
    // UNTIL may be in RRULE date format YYYYMMDD or ISO
    rule.until =
      until.length === 8
        ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
        : until;
  }

  return rule;
}

/**
 * Serialize a RecurrenceRule back to RRULE string.
 */
export function toRRuleString(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay && rule.byDay.length > 0)
    parts.push(`BYDAY=${rule.byDay.join(",")}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until)
    parts.push(`UNTIL=${rule.until.replace(/-/g, "")}`);
  return parts.join(";");
}

/**
 * Calculate the next occurrence date from a given date based on the recurrence rule.
 * Returns null if the recurrence has ended (count exhausted or past UNTIL date).
 */
export function getNextOccurrence(
  rule: RecurrenceRule,
  fromDate: Date,
  completionCount = 0,
): Date | null {
  // Check count limit
  if (rule.count !== undefined && completionCount >= rule.count) {
    return null;
  }

  const next = new Date(fromDate);

  switch (rule.freq) {
    case "DAILY":
      next.setDate(next.getDate() + rule.interval);
      break;

    case "WEEKLY":
      if (rule.byDay && rule.byDay.length > 0) {
        // Find next matching day
        const currentDay = next.getDay();
        const targetDays = rule.byDay
          .map((d) => DAY_MAP[d])
          .filter((d) => d !== undefined)
          .sort((a, b) => a - b);

        // Find the next day in the current or next week
        let found = false;
        for (const targetDay of targetDays) {
          const diff = targetDay - currentDay;
          if (diff > 0) {
            next.setDate(next.getDate() + diff);
            found = true;
            break;
          }
        }

        if (!found && targetDays.length > 0) {
          // Jump to the first day of the target in the next interval-week
          const firstTarget = targetDays[0] as number;
          const daysUntilNextWeek = 7 * rule.interval - currentDay + firstTarget;
          next.setDate(next.getDate() + daysUntilNextWeek);
        }
      } else {
        next.setDate(next.getDate() + 7 * rule.interval);
      }
      break;

    case "MONTHLY": {
      const origDay = next.getDate();
      next.setMonth(next.getMonth() + rule.interval);
      // Handle month-end overflow (e.g., Jan 31 → Feb 28)
      if (next.getDate() !== origDay) {
        next.setDate(0); // Sets to last day of previous month
      }
      break;
    }

    case "YEARLY":
      next.setFullYear(next.getFullYear() + rule.interval);
      break;
  }

  // Check UNTIL limit
  if (rule.until) {
    const untilDate = new Date(rule.until);
    if (next > untilDate) return null;
  }

  return next;
}

/**
 * Build a human-readable description of a recurrence rule.
 */
export function describeRule(rule: RecurrenceRule): string {
  const dayNames: Record<string, string> = {
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
    SU: "Sunday",
  };

  let desc = "";

  switch (rule.freq) {
    case "DAILY":
      desc = rule.interval === 1 ? "Every day" : `Every ${rule.interval} days`;
      break;
    case "WEEKLY":
      if (rule.byDay && rule.byDay.length > 0) {
        const days = rule.byDay.map((d) => dayNames[d] ?? d).join(", ");
        desc =
          rule.interval === 1
            ? `Every ${days}`
            : `Every ${rule.interval} weeks on ${days}`;
      } else {
        desc =
          rule.interval === 1
            ? "Every week"
            : `Every ${rule.interval} weeks`;
      }
      break;
    case "MONTHLY":
      desc =
        rule.interval === 1
          ? "Every month"
          : `Every ${rule.interval} months`;
      break;
    case "YEARLY":
      desc =
        rule.interval === 1
          ? "Every year"
          : `Every ${rule.interval} years`;
      break;
  }

  if (rule.count) desc += ` (${rule.count} times)`;
  if (rule.until) desc += ` until ${rule.until}`;

  return desc;
}
