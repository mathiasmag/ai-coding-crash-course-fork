import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getInstructorDashboard, type DashboardRange } from "./analyticsService";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysBeforeNow(days: number, extraMs = 0) {
  return new Date(NOW.getTime() - days * DAY_MS + extraMs).toISOString();
}

let userCounter = 0;

function createUser(role: schema.UserRole) {
  userCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `User ${userCounter}`,
      email: `user${userCounter}@example.com`,
      role,
    })
    .returning()
    .get();
}

function okDashboard(result: ReturnType<typeof getInstructorDashboard>) {
  if (result.outcome !== "ok") {
    throw new Error(`Expected outcome "ok", got "${result.outcome}"`);
  }
  return result.dashboard;
}

function courseTitles(result: ReturnType<typeof getInstructorDashboard>) {
  return okDashboard(result).courses.map((c) => c.title);
}

let courseCounter = 0;

function createCourse(
  instructorId: number,
  title: string,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  courseCounter++;
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: `course-${courseCounter}`,
      description: title,
      salesCopy: title,
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function buy(
  courseId: number,
  amountPaid: number,
  createdAt: string,
  country = "US"
) {
  const buyer = createUser(schema.UserRole.Student);
  return testDb
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId, amountPaid, country, createdAt })
    .returning()
    .get();
}

function viewOwn(range: DashboardRange = "30d") {
  return okDashboard(
    getInstructorDashboard({
      viewerId: base.instructor.id,
      instructorId: null,
      range,
      now: NOW,
    })
  );
}

describe("getInstructorDashboard", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("access", () => {
    it("lets an instructor view their own dashboard", () => {
      const result = getInstructorDashboard({
        viewerId: base.instructor.id,
        instructorId: null,
        range: "30d",
        now: NOW,
      });

      expect(result.outcome).toBe("ok");
    });

    it("forbids an instructor from viewing another instructor's dashboard", () => {
      const other = createUser(schema.UserRole.Instructor);

      const result = getInstructorDashboard({
        viewerId: base.instructor.id,
        instructorId: other.id,
        range: "30d",
        now: NOW,
      });

      expect(result.outcome).toBe("forbidden");
    });

    it("forbids a student, with or without an instructor id", () => {
      for (const instructorId of [null, base.instructor.id]) {
        const result = getInstructorDashboard({
          viewerId: base.user.id,
          instructorId,
          range: "30d",
          now: NOW,
        });

        expect(result.outcome).toBe("forbidden");
      }
    });

    it("asks an admin to pick an instructor when none is given", () => {
      const admin = createUser(schema.UserRole.Admin);

      const result = getInstructorDashboard({
        viewerId: admin.id,
        instructorId: null,
        range: "30d",
        now: NOW,
      });

      expect(result.outcome).toBe("pick-instructor");
    });

    it("shows an admin the chosen instructor's dashboard", () => {
      const admin = createUser(schema.UserRole.Admin);

      const result = getInstructorDashboard({
        viewerId: admin.id,
        instructorId: base.instructor.id,
        range: "30d",
        now: NOW,
      });

      expect(courseTitles(result)).toEqual(["Test Course"]);
    });

    it("asks an admin to pick again when the chosen id is not an instructor", () => {
      const admin = createUser(schema.UserRole.Admin);

      for (const instructorId of [base.user.id, 999_999]) {
        const result = getInstructorDashboard({
          viewerId: admin.id,
          instructorId,
          range: "30d",
          now: NOW,
        });

        expect(result.outcome).toBe("pick-instructor");
      }
    });
  });

  describe("courses included", () => {
    it("includes published and archived courses, excludes drafts and other instructors' courses", () => {
      const other = createUser(schema.UserRole.Instructor);
      createCourse(base.instructor.id, "Archived", schema.CourseStatus.Archived);
      createCourse(base.instructor.id, "Draft", schema.CourseStatus.Draft);
      createCourse(other.id, "Someone else's");

      const titles = viewOwn().courses.map((c) => c.title).sort();

      expect(titles).toEqual(["Archived", "Test Course"]);
    });
  });

  describe("sales", () => {
    it("sums what buyers actually paid, including PPP-discounted amounts", () => {
      buy(base.course.id, 4999, daysBeforeNow(3));
      buy(base.course.id, 2500, daysBeforeNow(10), "IN");

      const dashboard = viewOwn();

      expect(dashboard.sales.current).toBe(7499);
      expect(dashboard.courses[0].sales).toBe(7499);
    });

    it("counts a team purchase once at its full amount, ignoring coupon redemptions", () => {
      const teamPurchase = buy(base.course.id, 5 * 4999, daysBeforeNow(5));
      const team = testDb.insert(schema.teams).values({}).returning().get();
      const redeemers = [
        createUser(schema.UserRole.Student),
        createUser(schema.UserRole.Student),
      ];
      testDb
        .insert(schema.coupons)
        .values(
          ["A", "B", "C", "D", "E"].map((code, i) => ({
            teamId: team.id,
            courseId: base.course.id,
            code: `TEAM-${code}`,
            purchaseId: teamPurchase.id,
            redeemedByUserId: redeemers[i]?.id ?? null,
            redeemedAt: redeemers[i] ? daysBeforeNow(4) : null,
          }))
        )
        .run();
      for (const redeemer of redeemers) {
        testDb
          .insert(schema.enrollments)
          .values({
            userId: redeemer.id,
            courseId: base.course.id,
            enrolledAt: daysBeforeNow(4),
          })
          .run();
      }

      expect(viewOwn().sales.current).toBe(24995);
    });
  });

  describe("window", () => {
    it.each([
      ["7d", 7],
      ["30d", 30],
      ["90d", 90],
    ] as const)(
      "%s counts a purchase just inside the window and not one just outside",
      (range, days) => {
        buy(base.course.id, 100, daysBeforeNow(days)); // exactly on the boundary
        buy(base.course.id, 20, daysBeforeNow(0)); // exactly now
        buy(base.course.id, 3000, daysBeforeNow(days, -1)); // 1ms too early

        expect(viewOwn(range).sales.current).toBe(120);
      }
    );

    it("all time counts every purchase", () => {
      buy(base.course.id, 100, daysBeforeNow(1));
      buy(base.course.id, 200, daysBeforeNow(400));

      expect(viewOwn("all").sales.current).toBe(300);
    });
  });

  describe("comparison with the previous period", () => {
    it("reports the percentage change against the previous window of the same length", () => {
      buy(base.course.id, 15000, daysBeforeNow(1)); // current
      buy(base.course.id, 6000, daysBeforeNow(30, -1)); // previous, just after its end
      buy(base.course.id, 4000, daysBeforeNow(60)); // previous, on its start
      buy(base.course.id, 99999, daysBeforeNow(60, -1)); // before the previous window

      expect(viewOwn("30d").sales.comparison).toEqual({
        previous: 10000,
        changePercent: 50,
      });
    });

    it("reports no percentage when the previous period was zero", () => {
      buy(base.course.id, 15000, daysBeforeNow(1));

      expect(viewOwn("30d").sales.comparison).toEqual({
        previous: 0,
        changePercent: null,
      });
    });

    it("has no comparison for all time", () => {
      buy(base.course.id, 15000, daysBeforeNow(1));

      expect(viewOwn("all").sales.comparison).toBeNull();
    });
  });

  describe("per-course rows", () => {
    it("are sorted by sales in the window, highest first", () => {
      const small = createCourse(base.instructor.id, "Small");
      const big = createCourse(base.instructor.id, "Big", schema.CourseStatus.Archived);
      createCourse(base.instructor.id, "Nothing");
      buy(small.id, 1000, daysBeforeNow(2));
      buy(big.id, 9000, daysBeforeNow(2));
      buy(base.course.id, 5000, daysBeforeNow(2));
      buy(base.course.id, 99999, daysBeforeNow(45)); // outside the window

      const rows = viewOwn("30d").courses.map((c) => [c.title, c.sales]);

      expect(rows).toEqual([
        ["Big", 9000],
        ["Test Course", 5000],
        ["Small", 1000],
        ["Nothing", 0],
      ]);
    });

    it("carry what the table needs to link to the roster", () => {
      expect(viewOwn().courses).toEqual([
        {
          id: base.course.id,
          title: "Test Course",
          slug: "test-course",
          status: schema.CourseStatus.Published,
          sales: 0,
        },
      ]);
    });
  });

  describe("quiet periods", () => {
    it("reports zeros rather than nothing when the range has no activity", () => {
      buy(base.course.id, 5000, daysBeforeNow(200));

      const dashboard = viewOwn("7d");

      expect(dashboard.sales).toEqual({
        current: 0,
        comparison: { previous: 0, changePercent: null },
      });
      expect(dashboard.courses.map((c) => c.sales)).toEqual([0]);
    });

    it("returns no rows for an instructor without published or archived courses", () => {
      const fresh = createUser(schema.UserRole.Instructor);
      createCourse(fresh.id, "Draft only", schema.CourseStatus.Draft);

      const dashboard = okDashboard(
        getInstructorDashboard({
          viewerId: fresh.id,
          instructorId: fresh.id,
          range: "30d",
          now: NOW,
        })
      );

      expect(dashboard.courses).toEqual([]);
      expect(dashboard.sales.current).toBe(0);
    });
  });
});
