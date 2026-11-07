// ─── Analytics Service ───
// Reporting for the Instructor Dashboard. Single entry point,
// getInstructorDashboard, which also decides who may see which instructor.
//
// Takes a single object rather than positional parameters (the usual project
// convention): the PRD fixes this signature, and four loosely-related inputs
// read more clearly by name at the call site.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courses, purchases, UserRole, CourseStatus } from "~/db/schema";
import { getUserById } from "./userService";
import {
  DASHBOARD_RANGE_DAYS,
  type DashboardRange,
} from "~/lib/dashboard-range";

export type { DashboardRange };

// Archived courses keep their history; drafts have none worth reporting.
const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

export type DashboardCourseRow = {
  id: number;
  title: string;
  slug: string;
  status: CourseStatus;
  /** Cents actually paid in the current window. */
  sales: number;
};

export type Comparison = {
  previous: number;
  /** Change from the previous window, in percent. Null when previous is 0. */
  changePercent: number | null;
};

export type InstructorDashboard = {
  instructorId: number;
  range: DashboardRange;
  sales: {
    /** Cents actually paid in the current window. */
    current: number;
    /** Null for "all", which has no previous window. */
    comparison: Comparison | null;
  };
  courses: DashboardCourseRow[];
};

export type InstructorDashboardResult =
  | { outcome: "forbidden" }
  | { outcome: "pick-instructor" }
  | { outcome: "ok"; dashboard: InstructorDashboard };

const DAY_MS = 86_400_000;

/**
 * ISO timestamps. `start` is inclusive (null = unbounded). The current window
 * includes `now`; the previous window stops just short of the current start.
 */
type Window = { start: string | null; end: string; endInclusive: boolean };

function windowsFor(
  range: DashboardRange,
  now: Date
): { current: Window; previous: Window | null } {
  const days = DASHBOARD_RANGE_DAYS[range];
  const end = now.toISOString();
  if (days === null) {
    return { current: { start: null, end, endInclusive: true }, previous: null };
  }

  const length = days * DAY_MS;
  const start = new Date(now.getTime() - length).toISOString();
  return {
    current: { start, end, endInclusive: true },
    previous: {
      start: new Date(now.getTime() - 2 * length).toISOString(),
      end: start,
      endInclusive: false,
    },
  };
}

// Timestamps are stored as ISO-8601 UTC strings, so string comparison orders
// them chronologically.
function sumPaidWithin(window: Window) {
  const at = purchases.createdAt;
  const conditions = [
    window.endInclusive ? sql`${at} <= ${window.end}` : sql`${at} < ${window.end}`,
  ];
  if (window.start !== null) conditions.push(sql`${at} >= ${window.start}`);
  const inWindow = sql.join(conditions, sql` and `);
  return sql<number>`coalesce(sum(case when ${inWindow} then ${purchases.amountPaid} else 0 end), 0)`;
}

function compare(current: number, previous: number): Comparison {
  return {
    previous,
    changePercent:
      previous === 0 ? null : ((current - previous) / previous) * 100,
  };
}

export function getInstructorDashboard(input: {
  viewerId: number;
  instructorId: number | null;
  range: DashboardRange;
  now: Date;
}): InstructorDashboardResult {
  const { viewerId, instructorId, range, now } = input;
  const viewer = getUserById(viewerId);

  let targetId: number;
  if (viewer?.role === UserRole.Admin) {
    // Never fall back to an arbitrary instructor's numbers.
    if (
      instructorId === null ||
      getUserById(instructorId)?.role !== UserRole.Instructor
    ) {
      return { outcome: "pick-instructor" };
    }
    targetId = instructorId;
  } else if (viewer?.role === UserRole.Instructor) {
    if (instructorId !== null && instructorId !== viewerId) {
      return { outcome: "forbidden" };
    }
    targetId = viewerId;
  } else {
    return { outcome: "forbidden" };
  }

  const windows = windowsFor(range, now);

  const rows = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      status: courses.status,
      sales: sumPaidWithin(windows.current),
      previousSales: windows.previous
        ? sumPaidWithin(windows.previous)
        : sql<number>`0`,
    })
    .from(courses)
    .leftJoin(purchases, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(courses.instructorId, targetId),
        inArray(courses.status, INCLUDED_STATUSES)
      )
    )
    .groupBy(courses.id)
    .all();

  const sales = rows.reduce((total, row) => total + row.sales, 0);
  const previousSales = rows.reduce((total, row) => total + row.previousSales, 0);

  return {
    outcome: "ok",
    dashboard: {
      instructorId: targetId,
      range,
      sales: {
        current: sales,
        comparison: windows.previous ? compare(sales, previousSales) : null,
      },
      courses: rows
        .map(({ previousSales: _, ...row }) => row)
        .sort((a, b) => b.sales - a.sales || a.title.localeCompare(b.title)),
    },
  };
}
