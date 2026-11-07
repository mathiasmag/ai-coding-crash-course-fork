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
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  UserRole,
  CourseStatus,
  LessonProgressStatus,
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
  /**
   * Share (0–1) of the cohort that completed every lesson. Null when the
   * course has no lessons or nobody enrolled in the window.
   */
  completionRate: number | null;
  /**
   * Mean (0–1) of the cohort's best attempt per quiz. Null when the course has
   * no quizzes or nobody in the cohort has attempted one.
   */
  quizAverage: number | null;
  /** Share (0–1) of those best attempts meeting the quiz's passing score. */
  quizPassRate: number | null;
};

/** Completion across the cohort; see `cohortEnrollments`. */
export type CompletionSummary = {
  completed: number;
  learners: number;
  /** completed ÷ learners, weighted by enrollment. Null when no course has a rate. */
  rate: number | null;
};

/** Quiz scores across the cohort, pooling every (learner, quiz) best attempt. */
export type QuizSummary = {
  bestAttempts: number;
  average: number | null;
  passRate: number | null;
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
  completion: CompletionSummary;
  quiz: QuizSummary;
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

/**
 * The learners Completion (and later Quiz scores) report on: enrollments in
 * the included courses whose enrolledAt falls in the window — everyone for
 * "all". One row per enrollment.
 */
function cohortEnrollments(isIncluded: SQL | undefined, window: Window) {
  return db
    .select({ userId: enrollments.userId, courseId: enrollments.courseId })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(isIncluded, within(enrollments.enrolledAt, window)))
    .as("cohort");
}

/**
 * Per included course: cohort size, how many of them have completed every
 * current lesson (from lesson_progress, not enrollments.completedAt), and the
 * lesson count.
 */
function completionByCourse(isIncluded: SQL | undefined, window: Window) {
  const cohort = cohortEnrollments(isIncluded, window);

  const lessonCounts = db
    .select({
      courseId: modules.courseId,
      lessons: count(lessons.id).as("lesson_count"),
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .groupBy(modules.courseId)
    .as("lesson_counts");

  const completedLessons = db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      completed: sql<number>`count(distinct ${lessonProgress.lessonId})`.as(
        "completed_count"
      ),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(lessonProgress.status, LessonProgressStatus.Completed))
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completed_lessons");

  return db
    .select({
      id: courses.id,
      lessons: sql<number>`coalesce(max(${lessonCounts.lessons}), 0)`,
      learners: count(cohort.userId),
      completed: sql<number>`coalesce(sum(case when ${completedLessons.completed} = ${lessonCounts.lessons} then 1 else 0 end), 0)`,
    })
    .from(courses)
    .leftJoin(cohort, eq(cohort.courseId, courses.id))
    .leftJoin(lessonCounts, eq(lessonCounts.courseId, courses.id))
    .leftJoin(
      completedLessons,
      and(
        eq(completedLessons.userId, cohort.userId),
        eq(completedLessons.courseId, courses.id)
      )
    )
    .where(isIncluded)
    .groupBy(courses.id)
    .all();
}

type CourseCompletion = { lessons: number; learners: number; completed: number };

const NO_COMPLETION: CourseCompletion = { lessons: 0, learners: 0, completed: 0 };

/** part ÷ whole, or null when there is nothing to divide by. */
function rateOf(part: number, whole: number) {
  return whole === 0 ? null : part / whole;
}

/** Null when the course has no lessons or nobody in the cohort. */
function completionRate(course: CourseCompletion) {
  return course.lessons === 0 ? null : rateOf(course.completed, course.learners);
}

type CourseQuizTotals = { bestAttempts: number; scoreSum: number; passed: number };

const NO_QUIZ_ATTEMPTS: CourseQuizTotals = { bestAttempts: 0, scoreSum: 0, passed: 0 };

/**
 * Per included course, over the cohort's best attempt at each of the course's
 * quizzes: how many there are, their score total, and how many meet that
 * quiz's passing score. Courses with no such attempts are absent.
 */
function quizTotalsByCourse(isIncluded: SQL | undefined, window: Window) {
  const cohort = cohortEnrollments(isIncluded, window);

  const bestScores = db
    .select({
      userId: quizAttempts.userId,
      courseId: sql<number>`${modules.courseId}`.as("quiz_course_id"),
      passingScore: sql<number>`${quizzes.passingScore}`.as("passing_score"),
      best: sql<number>`max(${quizAttempts.score})`.as("best_score"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    // A quiz has one course and passing score; grouping by them too keeps the
    // query valid outside SQLite's bare-column leniency.
    .groupBy(
      quizAttempts.userId,
      quizAttempts.quizId,
      modules.courseId,
      quizzes.passingScore
    )
    .as("best_scores");

  return db
    .select({
      id: cohort.courseId,
      bestAttempts: count(),
      scoreSum: sql<number>`sum(${bestScores.best})`,
      passed: sql<number>`sum(case when ${bestScores.best} >= ${bestScores.passingScore} then 1 else 0 end)`,
    })
    .from(cohort)
    .innerJoin(
      bestScores,
      and(
        eq(bestScores.userId, cohort.userId),
        eq(bestScores.courseId, cohort.courseId)
      )
    )
    .groupBy(cohort.courseId)
    .all();
}

function quizFigures(totals: CourseQuizTotals) {
  return {
    average: rateOf(totals.scoreSum, totals.bestAttempts),
    passRate: rateOf(totals.passed, totals.bestAttempts),
  };
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

  const completionCounts = new Map(
    completionByCourse(isIncluded, windows.current).map((row) => [row.id, row])
  );

  const quizTotals = new Map(
    quizTotalsByCourse(isIncluded, windows.current).map((row) => [row.id, row])
  );

  const courseTotals = salesRows.map(({ previousSales, ...course }) => {
    const learners = learnerCounts.get(course.id);
    const completion = completionCounts.get(course.id) ?? NO_COMPLETION;
    const rate = completionRate(completion);
    const quiz = quizTotals.get(course.id) ?? NO_QUIZ_ATTEMPTS;
    const { average, passRate } = quizFigures(quiz);
    return {
      row: {
        ...course,
        learners: { new: learners?.new ?? 0, total: learners?.total ?? 0 },
        completionRate: rate,
        quizAverage: average,
        quizPassRate: passRate,
      },
      quiz,
      previousSales,
      previousNew: learners?.previousNew ?? 0,
      // Courses without a rate (no lessons, or nobody in the cohort) stay out
      // of the weighted roll-up.
      rolledUp: rate === null ? NO_COMPLETION : completion,
    };
  });

  const sumOf = (pick: (r: (typeof courseTotals)[number]) => number) =>
    courseTotals.reduce((total, r) => total + pick(r), 0);
  const sales = sumOf((r) => r.row.sales);
  const newLearners = sumOf((r) => r.row.learners.new);
  const completedLearners = sumOf((r) => r.rolledUp.completed);
  const cohortLearners = sumOf((r) => r.rolledUp.learners);
  const pooledQuiz: CourseQuizTotals = {
    bestAttempts: sumOf((r) => r.quiz.bestAttempts),
    scoreSum: sumOf((r) => r.quiz.scoreSum),
    passed: sumOf((r) => r.quiz.passed),
  };

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
      completion: {
        completed: completedLearners,
        learners: cohortLearners,
        rate: rateOf(completedLearners, cohortLearners),
      },
      quiz: { bestAttempts: pooledQuiz.bestAttempts, ...quizFigures(pooledQuiz) },
      courses: courseTotals
        .map((r) => r.row)
        .sort((a, b) => b.sales - a.sales || a.title.localeCompare(b.title)),
    },
  };
}
