// ─── Analytics Service ───
// Reporting for the Instructor Dashboard. Single entry point,
// getInstructorDashboard, which also decides who may see which instructor.
//
// Takes a single object rather than positional parameters (the usual project
// convention): the PRD fixes this signature, and four loosely-related inputs
// read more clearly by name at the call site.

import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  courses,
  enrollments,
  purchases,
  UserRole,
  CourseStatus,
} from "~/db/schema";
import { getUserById } from "./userService";
import {
  DASHBOARD_RANGE_DAYS,
  type DashboardRange,
} from "~/lib/dashboard-range";

export type { DashboardRange };

// Archived courses keep their history; drafts have none worth reporting.
const INCLUDED_STATUSES = [CourseStatus.Published, CourseStatus.Archived];

export type LearnerCounts = {
  /** Enrollments in the current window. */
  new: number;
  /** All enrollments, ignoring the range. */
  total: number;
};

export type DashboardCourseRow = {
  id: number;
  title: string;
  slug: string;
  status: CourseStatus;
  learners: LearnerCounts;
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
  learners: LearnerCounts & {
    /** Compares new learners. Null for "all", which has no previous window. */
    comparison: Comparison | null;
  };
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
function within(at: SQLiteColumn, window: Window): SQL {
  const conditions = [
    window.endInclusive ? sql`${at} <= ${window.end}` : sql`${at} < ${window.end}`,
  ];
  if (window.start !== null) conditions.push(sql`${at} >= ${window.start}`);
  return sql.join(conditions, sql` and `);
}

/** Sums `value` over the joined rows whose `at` falls in the window; 0 if none. */
function sumWithin(at: SQLiteColumn, value: SQL | SQLiteColumn, window: Window | null) {
  if (window === null) return sql<number>`0`;
  return sql<number>`coalesce(sum(case when ${within(at, window)} then ${value} else 0 end), 0)`;
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

  const isIncluded = and(
    eq(courses.instructorId, targetId),
    inArray(courses.status, INCLUDED_STATUSES)
  );

  // Two grouped queries rather than one: joining purchases and enrollments
  // together would multiply each course's rows.
  const salesRows = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      status: courses.status,
      sales: sumWithin(purchases.createdAt, purchases.amountPaid, windows.current),
      previousSales: sumWithin(purchases.createdAt, purchases.amountPaid, windows.previous),
    })
    .from(courses)
    .leftJoin(purchases, eq(purchases.courseId, courses.id))
    .where(isIncluded)
    .groupBy(courses.id)
    .all();

  const countEach = sql`1`;
  const learnerCounts = new Map(
    db
      .select({
        id: courses.id,
        new: sumWithin(enrollments.enrolledAt, countEach, windows.current),
        previousNew: sumWithin(enrollments.enrolledAt, countEach, windows.previous),
        total: count(enrollments.id),
      })
      .from(courses)
      .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
      .where(isIncluded)
      .groupBy(courses.id)
      .all()
      .map((row) => [row.id, row])
  );

  const courseTotals = salesRows.map(({ previousSales, ...course }) => {
    const learners = learnerCounts.get(course.id);
    return {
      row: {
        ...course,
        learners: { new: learners?.new ?? 0, total: learners?.total ?? 0 },
      },
      previousSales,
      previousNew: learners?.previousNew ?? 0,
    };
  });

  const sumOf = (pick: (r: (typeof courseTotals)[number]) => number) =>
    courseTotals.reduce((total, r) => total + pick(r), 0);
  const sales = sumOf((r) => r.row.sales);
  const newLearners = sumOf((r) => r.row.learners.new);

  return {
    outcome: "ok",
    dashboard: {
      instructorId: targetId,
      range,
      learners: {
        new: newLearners,
        total: sumOf((r) => r.row.learners.total),
        comparison: windows.previous
          ? compare(newLearners, sumOf((r) => r.previousNew))
          : null,
      },
      sales: {
        current: sales,
        comparison: windows.previous
          ? compare(sales, sumOf((r) => r.previousSales))
          : null,
      },
      courses: courseTotals
        .map((r) => r.row)
        .sort((a, b) => b.sales - a.sales || a.title.localeCompare(b.title)),
    },
  };
}
