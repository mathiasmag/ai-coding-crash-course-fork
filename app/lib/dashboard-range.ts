// ─── Dashboard Range ───
// The date ranges the Instructor Dashboard offers. Client-safe: the page's
// range selector imports these, so keep server-only code out of this module.

export const DASHBOARD_RANGES = ["7d", "30d", "90d", "all"] as const;

export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = "30d";

/** Days covered by each range; null means unbounded. */
export const DASHBOARD_RANGE_DAYS: Record<DashboardRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

export const DASHBOARD_RANGE_LABELS: Record<DashboardRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Completes "vs previous …". Null for "all", which has no previous period. */
export const DASHBOARD_RANGE_PERIODS: Record<DashboardRange, string | null> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: null,
};

/** Reads a `?range=` value. Missing or unknown values fall back to the default. */
export function parseDashboardRange(value: string | null): DashboardRange {
  return (DASHBOARD_RANGES as readonly string[]).includes(value ?? "")
    ? (value as DashboardRange)
    : DEFAULT_DASHBOARD_RANGE;
}
