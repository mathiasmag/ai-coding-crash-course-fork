import { Form, Link, data, isRouteErrorResponse, useSubmit } from "react-router";
import type { Route } from "./+types/instructor.dashboard";
import { requireUserId } from "~/lib/access.server";
import {
  getInstructorDashboard,
  type Comparison,
} from "~/services/analyticsService";
import { getUserById, getUsersByRole } from "~/services/userService";
import { CourseStatus, UserRole } from "~/db/schema";
import {
  DASHBOARD_RANGES,
  DASHBOARD_RANGE_LABELS,
  DASHBOARD_RANGE_PERIODS,
  DEFAULT_DASHBOARD_RANGE,
  parseDashboardRange,
  type DashboardRange,
} from "~/lib/dashboard-range";
import { cn, formatMoney } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { AlertTriangle, GraduationCap, UserSearch } from "lucide-react";

// ─── Instructor Dashboard ───
// Reporting on how an instructor's courses are doing. Separate from "My
// Courses" (/instructor), which is for managing them.
//
// Who may see which instructor is decided by analyticsService, not here — the
// loader only maps its outcome to a 403, the admin picker prompt, or the page.

export function meta() {
  return [
    { title: "Dashboard — Cadence" },
    { name: "description", content: "How your courses are doing" },
  ];
}

function parseInstructorId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export async function loader({ request, url }: Route.LoaderArgs) {
  const viewerId = await requireUserId(request);
  const range = parseDashboardRange(url.searchParams.get("range"));
  const instructorId = parseInstructorId(url.searchParams.get("instructorId"));

  const result = getInstructorDashboard({
    viewerId,
    instructorId,
    range,
    now: new Date(),
  });

  if (result.outcome === "forbidden") {
    throw data("You can only view your own instructor dashboard.", {
      status: 403,
    });
  }

  const isAdmin = getUserById(viewerId)?.role === UserRole.Admin;
  const instructors = isAdmin
    ? getUsersByRole(UserRole.Instructor).map((u) => ({ id: u.id, name: u.name }))
    : [];

  return {
    range,
    isAdmin,
    instructors,
    dashboard: result.outcome === "ok" ? result.dashboard : null,
  };
}

// ─── Header controls ───

function rangeHref(range: DashboardRange, instructorId: number | null) {
  const params = new URLSearchParams();
  if (instructorId !== null) params.set("instructorId", String(instructorId));
  if (range !== DEFAULT_DASHBOARD_RANGE) params.set("range", range);
  const query = params.toString();
  return query ? `/instructor/dashboard?${query}` : "/instructor/dashboard";
}

function RangeSelector({
  range,
  instructorId,
}: {
  range: DashboardRange;
  instructorId: number | null;
}) {
  return (
    <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Date range">
      {DASHBOARD_RANGES.map((option) => (
        <Link
          key={option}
          to={rangeHref(option, instructorId)}
          aria-current={option === range ? "true" : undefined}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            option === range
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {DASHBOARD_RANGE_LABELS[option]}
        </Link>
      ))}
    </div>
  );
}

function InstructorPicker({
  instructors,
  instructorId,
  range,
}: {
  instructors: { id: number; name: string }[];
  instructorId: number | null;
  range: DashboardRange;
}) {
  const submit = useSubmit();

  return (
    <Form method="get" onChange={(e) => submit(e.currentTarget)}>
      {range !== DEFAULT_DASHBOARD_RANGE && (
        <input type="hidden" name="range" value={range} />
      )}
      <label className="sr-only" htmlFor="instructorId">
        Instructor
      </label>
      <select
        id="instructorId"
        name="instructorId"
        defaultValue={instructorId ?? ""}
        key={instructorId ?? "none"}
        className="h-9 rounded-md border bg-background px-3 text-sm"
      >
        <option value="" disabled>
          Pick an instructor…
        </option>
        {instructors.map((instructor) => (
          <option key={instructor.id} value={instructor.id}>
            {instructor.name}
          </option>
        ))}
      </select>
      <noscript>
        <Button type="submit" variant="outline" size="sm" className="ml-2">
          View
        </Button>
      </noscript>
    </Form>
  );
}

// ─── Body ───

function formatChange(changePercent: number | null) {
  if (changePercent === null) return "—";
  const rounded = Math.round(changePercent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** "+12% vs previous 30 days"; renders nothing for "all time". */
function ComparisonNote({
  comparison,
  previousPeriod,
}: {
  comparison: Comparison | null;
  previousPeriod: string | null;
}) {
  if (!comparison || !previousPeriod) return null;
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      {formatChange(comparison.changePercent)} vs previous {previousPeriod}
    </p>
  );
}

/** Completion and quiz scores count the learners who enrolled in the range, not everyone. */
function cohortNote(range: DashboardRange) {
  return range === "all"
    ? "Completion and quiz scores cover all learners."
    : `Completion and quiz scores cover learners who enrolled in the ${DASHBOARD_RANGE_LABELS[range].toLowerCase()}.`;
}

function formatRate(rate: number | null) {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function statusLabel(status: CourseStatus) {
  return status === CourseStatus.Archived ? "Archived" : "Published";
}

export default function InstructorDashboardPage({
  loaderData,
}: Route.ComponentProps) {
  const { range, isAdmin, instructors, dashboard } = loaderData;
  const instructorId = isAdmin ? (dashboard?.instructorId ?? null) : null;
  const previousPeriod = DASHBOARD_RANGE_PERIODS[range];

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="mt-1 text-muted-foreground">
            How your courses are doing
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {isAdmin && (
            <InstructorPicker
              instructors={instructors}
              instructorId={instructorId}
              range={range}
            />
          )}
          <RangeSelector range={range} instructorId={instructorId} />
        </div>
      </div>

      {!dashboard ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <UserSearch className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">Pick an instructor</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose an instructor above to see their dashboard.
          </p>
        </div>
      ) : dashboard.courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No published courses yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Numbers appear here once a course is published.
          </p>
          <Link to="/instructor" className="mt-4">
            <Button>Go to My Courses</Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Learners
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {dashboard.learners.new}
                  <span className="ml-1 text-base font-normal text-muted-foreground">
                    new
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {dashboard.learners.total} total
                </p>
                <ComparisonNote
                  comparison={dashboard.learners.comparison}
                  previousPeriod={previousPeriod}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Sales
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {formatMoney(dashboard.sales.current)}
                </div>
                <ComparisonNote
                  comparison={dashboard.sales.comparison}
                  previousPeriod={previousPeriod}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Completion
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {formatRate(dashboard.completion.rate)}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {dashboard.completion.completed} of{" "}
                  {dashboard.completion.learners} learners finished
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Quiz scores
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {formatRate(dashboard.quiz.average)}
                  <span className="ml-1 text-base font-normal text-muted-foreground">
                    avg
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatRate(dashboard.quiz.passRate)} pass rate
                </p>
              </CardContent>
            </Card>
          </div>

          <p className="-mt-4 mb-6 text-xs text-muted-foreground">
            {cohortNote(range)}
          </p>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Course</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">
                      New learners
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Total learners
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Sales</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Completion
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Quiz avg
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Quiz pass rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.courses.map((course) => (
                    <tr key={course.id} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <Link
                          to={`/instructor/${course.id}/students`}
                          className="font-medium hover:text-primary hover:underline"
                        >
                          {course.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {statusLabel(course.status)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {course.learners.new}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {course.learners.total}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatMoney(course.sales)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatRate(course.completionRate)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatRate(course.quizAverage)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatRate(course.quizPassRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading the dashboard.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
