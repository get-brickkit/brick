import { describe, expect, it } from "bun:test";
import {
  hasFilters,
  historyParams,
  NO_FILTERS,
  sparkGroups,
  type LogFilters,
  type LogRow,
} from "../dashboard/filters";
import {
  applyFilters,
  bucketRows,
  computeFacets,
  outcomeOf,
  summarizeRows,
  toRow,
} from "../src/dashboard-query";
import type { TraceSummary } from "../src/dashboard-protocol";

function row(id: string, options: Partial<LogRow> = {}): LogRow {
  return {
    traceId: id,
    name: "GET /api/pages",
    endpoint: "GET /api/pages",
    method: "GET",
    route: "/api/pages",
    path: "/api/pages",
    httpStatus: 200,
    generation: 1,
    startMs: 1_000,
    endMs: 1_010,
    durationMs: 10,
    status: "ok",
    truncated: false,
    ...options,
  };
}

const filters = (options: Partial<LogFilters> = {}): LogFilters => ({
  ...NO_FILTERS,
  ...options,
});

const sample = [
  row("list", { startMs: 5_000, service: "pages", action: "page.list" }),
  row("create", {
    startMs: 4_000,
    method: "POST",
    endpoint: "POST /api/pages",
    durationMs: 300,
    service: "pages",
    action: "page.create",
  }),
  row("login", {
    startMs: 3_000,
    method: "POST",
    route: "/api/auth/login",
    endpoint: "POST /api/auth/login",
    path: "/api/auth/login",
    httpStatus: 401,
    service: "auth",
    action: "login",
    message: "Wrong password",
  }),
  row("boom", {
    startMs: 2_000,
    httpStatus: 500,
    status: "error",
    service: "pages",
    message: "db down",
  }),
];

describe("outcomeOf", () => {
  it("separates server faults from client errors", () => {
    expect(outcomeOf({ status: "ok", httpStatus: 200 })).toBe("ok");
    expect(outcomeOf({ status: "ok", httpStatus: undefined })).toBe("ok");
    expect(outcomeOf({ status: "ok", httpStatus: 404 })).toBe("client");
    expect(outcomeOf({ status: "ok", httpStatus: 503 })).toBe("server");
    expect(outcomeOf({ status: "error", httpStatus: 404 })).toBe("server");
    expect(outcomeOf({ status: "running", httpStatus: undefined })).toBe("ok");
  });
});

describe("toRow", () => {
  it("turns a live request into a log row without its spans", () => {
    const trace: TraceSummary = {
      traceId: "t",
      name: "POST /api/x",
      method: "POST",
      route: "/api/x",
      generation: 2,
      startMs: 1,
      status: "running",
      truncated: false,
      spans: [],
    };
    const result = toRow(trace);
    expect(result.endpoint).toBe("POST /api/x");
    expect(result).not.toHaveProperty("spans");
    expect(toRow({ ...trace, route: undefined }).endpoint).toBe("POST /api/x");
  });
});

describe("applyFilters", () => {
  const ids = (list: LogRow[]) => list.map((item) => item.traceId);

  it("shows everything newest first, or the slowest first", () => {
    expect(ids(applyFilters(sample, NO_FILTERS))).toEqual([
      "list",
      "create",
      "login",
      "boom",
    ]);
    expect(ids(applyFilters(sample, filters({ sort: "slowest" })))[0]).toBe(
      "create",
    );
  });

  it("combines filters with AND and the values of one with OR", () => {
    expect(ids(applyFilters(sample, filters({ methods: ["POST"] })))).toEqual([
      "create",
      "login",
    ]);
    expect(
      ids(
        applyFilters(
          sample,
          filters({ methods: ["POST"], services: ["pages"] }),
        ),
      ),
    ).toEqual(["create"]);
    expect(
      ids(applyFilters(sample, filters({ outcomes: ["client", "server"] }))),
    ).toEqual(["login", "boom"]);
    expect(ids(applyFilters(sample, filters({ minMs: 100 })))).toEqual([
      "create",
    ]);
  });

  it("searches the route, path, action, and failure message, ignoring case", () => {
    expect(
      ids(applyFilters(sample, filters({ query: "PAGE.CREATE" }))),
    ).toEqual(["create"]);
    expect(ids(applyFilters(sample, filters({ query: "wrong pass" })))).toEqual(
      ["login"],
    );
    expect(ids(applyFilters(sample, filters({ query: "  /auth  " })))).toEqual([
      "login",
    ]);
  });
});

describe("computeFacets", () => {
  it("counts each filter's values as if that filter were not applied", () => {
    const everything = computeFacets(sample, NO_FILTERS);
    expect(everything.outcome).toEqual(
      [
        { value: "client", count: 1 },
        { value: "ok", count: 2 },
        { value: "server", count: 1 },
      ].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    );
    expect(everything.service).toEqual([
      { value: "pages", count: 3 },
      { value: "auth", count: 1 },
    ]);

    const posts = computeFacets(sample, filters({ methods: ["POST"] }));
    // The method counts ignore the method choice; the others narrow to POST.
    expect(posts.method).toEqual(everything.method);
    expect(posts.service).toEqual([
      { value: "auth", count: 1 },
      { value: "pages", count: 1 },
    ]);
  });
});

describe("bucketRows", () => {
  it("counts rows into equal buckets by outcome, keeping the last edge", () => {
    const buckets = bucketRows(
      [
        row("a", { startMs: 0 }),
        row("b", { startMs: 4_999, httpStatus: 404 }),
        row("c", { startMs: 10_000, httpStatus: 500, status: "error" }),
        row("outside", { startMs: 20_000 }),
      ],
      0,
      10_000,
      2,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ ok: 1, client: 1, server: 0 });
    expect(buckets[1]).toMatchObject({ ok: 0, client: 0, server: 1 });
  });
});

describe("history query strings", () => {
  const window = { from: 1_000, to: 2_000 };

  it("sends only the time window when nothing is filtered", () => {
    expect(historyParams(window, NO_FILTERS).toString()).toBe(
      "from=1000&to=2000",
    );
  });

  it("repeats a parameter for each chosen value and adds the page", () => {
    const params = historyParams(
      window,
      filters({
        endpoints: ["GET /a", "POST /b"],
        methods: ["GET"],
        services: ["pages"],
        outcomes: ["server", "client"],
        minMs: 500,
        query: "  pages ",
        sort: "slowest",
      }),
      { offset: 200 },
    );
    expect(params.getAll("endpoint")).toEqual(["GET /a", "POST /b"]);
    expect(params.getAll("outcome")).toEqual(["server", "client"]);
    expect(Object.fromEntries(params)).toMatchObject({
      method: "GET",
      service: "pages",
      minMs: "500",
      q: "pages",
      sort: "slowest",
      limit: "100",
      offset: "200",
    });
  });

  it("leaves out blank text and the default order", () => {
    const params = historyParams(window, filters({ query: "   " }));
    expect(params.has("q")).toBe(false);
    expect(params.has("sort")).toBe(false);
  });
});

describe("hasFilters", () => {
  it("is false until something narrows the list", () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters(filters({ sort: "slowest" }))).toBe(false);
    expect(hasFilters(filters({ query: "   " }))).toBe(false);
    expect(hasFilters(filters({ query: "x" }))).toBe(true);
    expect(hasFilters(filters({ minMs: 100 }))).toBe(true);
    expect(hasFilters(filters({ methods: ["GET"] }))).toBe(true);
  });
});

describe("summarizeRows", () => {
  it("counts failures by kind and finds the median and slowest 5%", () => {
    const rows = [
      ...Array.from({ length: 18 }, (_, index) =>
        row(`ok${index}`, { durationMs: (index + 1) * 10 }),
      ),
      row("missing", { httpStatus: 404, durationMs: 5 }),
      row("boom", { httpStatus: 500, status: "error", durationMs: 1_000 }),
    ];
    const summary = summarizeRows(rows);
    expect(summary).toMatchObject({
      total: 20,
      clientErrors: 1,
      serverErrors: 1,
    });
    expect(summary.medianMs).toBeCloseTo(95, 5);
    expect(summary.p95Ms).toBeGreaterThan(170);
  });

  it("skips requests that have not finished and handles none at all", () => {
    expect(
      summarizeRows([
        row("running", { status: "running", durationMs: undefined }),
      ]),
    ).toMatchObject({ total: 1, medianMs: 0, p95Ms: 0 });
    expect(summarizeRows([])).toEqual({
      total: 0,
      clientErrors: 0,
      serverErrors: 0,
      medianMs: 0,
      p95Ms: 0,
    });
  });
});

describe("sparkGroups", () => {
  const bucket = (ok: number, client = 0, server = 0) => ({
    start: 0,
    ok,
    client,
    server,
  });

  it("folds buckets into a few columns, oldest first", () => {
    const groups = sparkGroups(
      [bucket(1), bucket(2), bucket(3, 1), bucket(4, 0, 2)],
      2,
    );
    expect(groups.requests).toEqual([3, 10]);
    expect(groups.errors).toEqual([0, 3]);
  });

  it("gives empty columns before any data has loaded", () => {
    expect(sparkGroups(undefined, 3)).toEqual({
      requests: [0, 0, 0],
      errors: [0, 0, 0],
    });
  });
});
