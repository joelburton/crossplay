import { describe, expect, it } from "vitest";
import { formatRelative } from "./relativeTime";

/** Fixed reference point so cases stay readable. Local time — the
 *  formatter uses calendar-day comparisons in the runtime's timezone,
 *  so we feed it Date objects rather than UTC strings to avoid the test
 *  becoming TZ-dependent. */
const NOW = new Date(2026, 4, 10, 12, 0, 0); // May 10 2026, noon local

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("formatRelative", () => {
  it("renders 'just now' under 60 seconds", () => {
    expect(formatRelative(ago(0), NOW)).toBe("just now");
    expect(formatRelative(ago(59_000), NOW)).toBe("just now");
  });

  it("clock skew (future timestamps) falls through to 'just now'", () => {
    expect(formatRelative(new Date(NOW.getTime() + 10_000).toISOString(), NOW)).toBe("just now");
  });

  it("renders 'Nm ago' for 1–59 minutes", () => {
    expect(formatRelative(ago(60_000), NOW)).toBe("1m ago");
    expect(formatRelative(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(formatRelative(ago(59 * 60_000), NOW)).toBe("59m ago");
  });

  it("renders 'Nh ago' for 1–23 hours", () => {
    expect(formatRelative(ago(60 * 60_000), NOW)).toBe("1h ago");
    expect(formatRelative(ago(23 * 60 * 60_000), NOW)).toBe("23h ago");
  });

  it("renders 'yesterday' once we're past 24h and into the prior calendar day", () => {
    // 25h ago: hours-branch is exhausted (>=24), days = 1 → "yesterday".
    expect(formatRelative(ago(25 * 60 * 60_000), NOW)).toBe("yesterday");
  });

  it("renders 'N days ago' for 2–6 calendar days back", () => {
    expect(formatRelative(new Date(2026, 4, 8, 12, 0, 0).toISOString(), NOW)).toBe("2 days ago");
    expect(formatRelative(new Date(2026, 4, 4, 12, 0, 0).toISOString(), NOW)).toBe("6 days ago");
  });

  it("renders 'Mon D' within the same calendar year (7+ days back)", () => {
    expect(formatRelative(new Date(2026, 4, 3, 9, 0, 0).toISOString(), NOW)).toBe("May 3");
    expect(formatRelative(new Date(2026, 0, 1, 9, 0, 0).toISOString(), NOW)).toBe("Jan 1");
  });

  it("renders 'Mon D, YYYY' across years", () => {
    expect(formatRelative(new Date(2025, 4, 3, 9, 0, 0).toISOString(), NOW)).toBe("May 3, 2025");
    expect(formatRelative(new Date(2024, 11, 31, 9, 0, 0).toISOString(), NOW)).toBe("Dec 31, 2024");
  });

  it("returns '' for an unparseable ISO string", () => {
    expect(formatRelative("not-a-date", NOW)).toBe("");
  });
});
