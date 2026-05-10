/**
 * Friendly relative-time formatter for the home page's "your games" list.
 *
 * Standard ladder:
 *   - < 60s        → "just now"
 *   - < 60m        → "Nm ago"
 *   - < 24h        → "Nh ago"
 *   - yesterday    → "yesterday"     (calendar-day comparison, local time)
 *   - < 7 days     → "N days ago"    (calendar-day comparison, local time)
 *   - same year    → "May 3"
 *   - earlier      → "May 3, 2025"
 *
 * Pure — takes `now` as an optional second arg so callers (and tests)
 * can control the reference point. Always uses the runtime's local
 * timezone; no UTC normalization.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const deltaMs = now.getTime() - then.getTime();

  // Future timestamps (clock skew, etc.) — fall through to "just now".
  if (deltaMs < 60_000) return "just now";

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;

  const days = calendarDayDiff(then, now);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  const month = MONTHS[then.getMonth()]!;
  const day = then.getDate();
  if (then.getFullYear() === now.getFullYear()) return `${month} ${day}`;
  return `${month} ${day}, ${then.getFullYear()}`;
}

/** Calendar-day delta (local time): midnight-to-midnight, so a 2am-on-
 *  Tuesday "now" and an 11pm-on-Monday "then" report as 1 day, not 0. */
function calendarDayDiff(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}
