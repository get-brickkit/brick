import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevHistory, openHistory } from "../src/dev-history";
import {
  applyFilters,
  bucketRows,
  decodeHistoryQuery,
  type HistoryQuery,
  computeFacets,
  summarizeRows,
  toRow,
  tracesToCsv,
} from "../src/dashboard-query";
import type { TraceSummary } from "../src/dashboard-protocol";

const DAY = 86_400_000;
// Retention is measured from the real clock, so the fixtures are too.
const NOW = Date.now();

const directories: string[] = [];
const opened: DevHistory[] = [];

afterEach(() => {
  for (const history of opened.splice(0)) history.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function open(days = 90): Promise<DevHistory> {
  const directory = mkdtempSync(join(tmpdir(), "brick-history-"));
  directories.push(directory);
  const history = await openHistory({ directory, days });
  if (!history) throw new Error("history did not open");
  opened.push(history);
  return history;
}

function trace(
  id: string,
  options: Partial<TraceSummary> & { agoMs?: number } = {},
): TraceSummary {
  const { agoMs = 0, ...rest } = options;
  const startMs = NOW - agoMs;
  return {
    traceId: id,
    name: "GET /api/pages",
    method: "GET",
    route: "/api/pages",
    path: "/api/pages",
    httpStatus: 200,
    generation: 1,
    startMs,
    endMs: startMs + 10,
    durationMs: 10,
    status: "ok",
    truncated: false,
    spans: [
      {
        spanId: `${id}-root`,
        name: "GET /api/pages",
        startMs,
        endMs: startMs + 10,
        status: "ok",
        attributes: { "http.route": "/api/pages" },
        events: [],
      },
    ],
    ...rest,
  };
}

describe("openHistory", () => {
  it("keeps requests out of version control and stays off at zero days", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brick-history-"));
    directories.push(directory);

    expect(await openHistory({ directory, days: 0 })).toBeUndefined();
    expect(existsSync(join(directory, ".brick"))).toBe(false);

    const history = await openHistory({ directory, days: 30 });
    opened.push(history!);
    expect(history?.days).toBe(30);
    expect(readFileSync(join(directory, ".brick", ".gitignore"), "utf8")).toBe(
      "*\n",
    );
    expect(existsSync(join(directory, ".brick", "telemetry.sqlite"))).toBe(
      true,
    );
  });

  it("explains itself instead of throwing when the folder is unusable", async () => {
    const warnings: string[] = [];
    const history = await openHistory({
      directory: "/dev/null/not-a-folder",
      days: 90,
      warn: (message) => warnings.push(message),
    });
    expect(history).toBeUndefined();
    expect(warnings[0]).toContain("Request history is unavailable");
  });

  it("adds the newer columns to a folder from an earlier version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brick-history-"));
    directories.push(directory);
    const first = (await openHistory({ directory, days: 90 }))!;
    first.close();

    // Rebuild the table the way the first release created it.
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as {
      Database: new (file: string) => {
        exec(sql: string): void;
        prepare(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const file = join(directory, ".brick", "telemetry.sqlite");
    const raw = new Database(file);
    raw.exec(
      `CREATE TABLE failures (id INTEGER PRIMARY KEY, at INTEGER, stack TEXT)`,
    );
    raw.exec(`DROP TABLE traces; CREATE TABLE traces (
      trace_id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL,
      method TEXT, route TEXT, path TEXT, http_status INTEGER, generation INTEGER NOT NULL,
      start_ms INTEGER NOT NULL, end_ms INTEGER, duration_ms REAL, status TEXT NOT NULL,
      truncated INTEGER NOT NULL, spans TEXT NOT NULL)`);
    raw.close();

    const upgraded = (await openHistory({ directory, days: 90 }))!;
    opened.push(upgraded);
    upgraded.saveTrace(trace("new", { service: "pages", message: "hello" }));
    const [row] = upgraded.traces({ from: NOW - DAY, to: NOW + 1000 }).traces;
    expect(row).toMatchObject({ service: "pages", message: "hello" });

    // The failures an earlier version kept are gone, stack traces included.
    const check = new Database(file);
    const leftover = check
      .prepare("SELECT name FROM sqlite_master WHERE name = 'failures'")
      .all();
    check.close();
    expect(leftover).toEqual([]);
  });

  it("keeps what was saved when the app runs again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brick-history-"));
    directories.push(directory);
    const first = (await openHistory({ directory, days: 90 }))!;
    first.saveTrace(trace("kept", { agoMs: DAY }));
    first.close();

    const second = (await openHistory({ directory, days: 90 }))!;
    opened.push(second);
    expect(second.trace("kept")?.traceId).toBe("kept");
  });
});

describe("DevHistory", () => {
  it("warns once per kind of failure when it cannot write or prune", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brick-history-"));
    directories.push(directory);
    const warnings: string[] = [];
    const history = (await openHistory({
      directory,
      days: 90,
      warn: (message) => warnings.push(message),
    }))!;
    opened.push(history);
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as {
      Database: new (file: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const raw = new Database(join(directory, ".brick", "telemetry.sqlite"));
    raw.exec("DROP TABLE traces");
    raw.close();

    for (const id of ["a", "b"]) {
      history.saveTrace(trace(id));
      history.flush();
      history.prune();
    }
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(
      "Could not save requests to the request history",
    );
    expect(warnings[1]).toContain("Could not prune the request history");
  });

  it("returns a saved request with its spans, and replaces it when saved again", async () => {
    const history = await open();
    history.saveTrace(trace("a", { httpStatus: 200 }));
    history.saveTrace(trace("a", { httpStatus: 201, durationMs: 25 }));

    const saved = history.trace("a");
    expect(saved).toMatchObject({ httpStatus: 201, durationMs: 25 });
    expect(saved?.spans[0]).toMatchObject({ spanId: "a-root" });
    expect(history.info().count).toBe(1);
    expect(history.trace("missing")).toBeUndefined();
  });

  it("lists requests newest first, without spans, within the time range", async () => {
    const history = await open();
    history.saveTrace(trace("new", { agoMs: 1_000 }));
    history.saveTrace(trace("week", { agoMs: 6 * DAY }));
    history.saveTrace(trace("old", { agoMs: 40 * DAY }));

    const result = history.traces({ from: NOW - 7 * DAY, to: NOW });
    expect(result.total).toBe(2);
    expect(result.traces.map((item) => item.traceId)).toEqual(["new", "week"]);
    expect(result.traces[0]).not.toHaveProperty("spans");
    expect(result.traces[0].endpoint).toBe("GET /api/pages");

    const everything = history.traces({ from: NOW - 90 * DAY, to: NOW });
    expect(everything.total).toBe(3);
  });

  it("filters by endpoint, outcome, minimum duration, and text", async () => {
    const history = await open();
    history.saveTrace(trace("ok", { agoMs: 1 }));
    history.saveTrace(
      trace("slow", {
        agoMs: 2,
        durationMs: 900,
        route: "/api/slow",
        path: "/api/slow",
      }),
    );
    history.saveTrace(trace("missing", { agoMs: 3, httpStatus: 404 }));
    history.saveTrace(
      trace("boom", { agoMs: 4, httpStatus: 500, status: "error" }),
    );
    const range = { from: NOW - DAY, to: NOW };
    const ids = (query: Partial<Parameters<DevHistory["traces"]>[0]>) =>
      history.traces({ ...range, ...query }).traces.map((item) => item.traceId);

    expect(ids({ outcomes: ["ok"] })).toEqual(["ok", "slow"]);
    expect(ids({ outcomes: ["client"] })).toEqual(["missing"]);
    expect(ids({ outcomes: ["server"] })).toEqual(["boom"]);
    expect(ids({ outcomes: ["client", "server"] })).toEqual([
      "missing",
      "boom",
    ]);
    expect(ids({ endpoints: ["GET /api/slow"] })).toEqual(["slow"]);
    expect(ids({ minMs: 500 })).toEqual(["slow"]);
    expect(ids({ query: "SLOW" })).toEqual(["slow"]);
    // Wildcard characters in the text are matched literally.
    expect(ids({ query: "%" })).toEqual([]);
    expect(ids({ query: "api_pages" })).toEqual([]);
  });

  it("combines different filters and accepts several values for one", async () => {
    const history = await open();
    history.saveTrace(
      trace("list", { agoMs: 1, service: "pages", action: "page.list" }),
    );
    history.saveTrace(
      trace("create", {
        agoMs: 2,
        method: "POST",
        service: "pages",
        action: "page.create",
      }),
    );
    history.saveTrace(
      trace("login", {
        agoMs: 3,
        method: "POST",
        route: "/api/auth/login",
        service: "auth",
        action: "login",
        httpStatus: 401,
        message: "Wrong password",
      }),
    );
    const range = { from: NOW - DAY, to: NOW };
    const ids = (query: Partial<Parameters<DevHistory["traces"]>[0]>) =>
      history.traces({ ...range, ...query }).traces.map((item) => item.traceId);

    expect(ids({ methods: ["POST"] })).toEqual(["create", "login"]);
    expect(ids({ methods: ["POST"], services: ["pages"] })).toEqual(["create"]);
    expect(ids({ services: ["pages", "auth"] })).toEqual([
      "list",
      "create",
      "login",
    ]);
    // Text also matches the action and the failure message.
    expect(ids({ query: "page.create" })).toEqual(["create"]);
    expect(ids({ query: "wrong pass" })).toEqual(["login"]);

    const [row] = history.traces({ ...range, services: ["auth"] }).traces;
    expect(row).toMatchObject({
      service: "auth",
      action: "login",
      message: "Wrong password",
    });
  });

  it("counts each filter's values as if that filter were not applied", async () => {
    const history = await open();
    const save = (id: string, options: Parameters<typeof trace>[1]) =>
      history.saveTrace(trace(id, { agoMs: 1_000, ...options }));
    save("a", { service: "pages" });
    save("b", { service: "pages", httpStatus: 404 });
    save("c", {
      service: "auth",
      method: "POST",
      httpStatus: 500,
      status: "error",
    });
    const range = { from: NOW - DAY, to: NOW };

    const everything = history.facets(range);
    expect(everything.outcome).toEqual([
      { value: "client", count: 1 },
      { value: "ok", count: 1 },
      { value: "server", count: 1 },
    ]);
    expect(everything.method).toEqual([
      { value: "GET", count: 2 },
      { value: "POST", count: 1 },
    ]);
    expect(everything.service).toEqual([
      { value: "pages", count: 2 },
      { value: "auth", count: 1 },
    ]);

    // Choosing a service narrows the other counts but not its own.
    const pages = history.facets({ ...range, services: ["pages"] });
    expect(pages.service).toEqual(everything.service);
    expect(pages.outcome).toEqual([
      { value: "client", count: 1 },
      { value: "ok", count: 1 },
    ]);
    expect(pages.method).toEqual([{ value: "GET", count: 2 }]);
  });

  it("counts matching requests per time bucket by outcome", async () => {
    const history = await open();
    history.saveTrace(trace("early", { agoMs: DAY - 1_000 }));
    history.saveTrace(
      trace("early-fail", {
        agoMs: DAY - 2_000,
        httpStatus: 500,
        status: "error",
      }),
    );
    history.saveTrace(trace("late", { agoMs: 1_000, httpStatus: 404 }));
    const range = { from: NOW - DAY, to: NOW };

    const volume = history.volume(range, 24);
    expect(volume).toHaveLength(24);
    expect(volume[0]).toMatchObject({ ok: 1, server: 1, client: 0 });
    expect(volume[23]).toMatchObject({ client: 1, ok: 0 });

    const onlyOk = history.volume({ ...range, outcomes: ["ok"] }, 24);
    const total = onlyOk.reduce(
      (sum, bucket) => sum + bucket.ok + bucket.client + bucket.server,
      0,
    );
    expect(total).toBe(1);
  });

  it("exports matching requests as CSV a spreadsheet can open", async () => {
    const history = await open();
    history.saveTrace(
      trace("one", {
        agoMs: 1_000,
        durationMs: 12.5,
        service: "pages",
        action: "page.list",
      }),
    );
    history.saveTrace(
      trace("two", {
        agoMs: 2_000,
        httpStatus: 500,
        status: "error",
        message: 'He said "no", then =cmd',
      }),
    );
    const range = { from: NOW - DAY, to: NOW };
    const csv = history.exportCsv(range);
    const [header, first, second] = csv.trim().split("\n");
    expect(header).toBe(
      "time,method,route,path,status,outcome,duration_ms,service,action,message,trace_id",
    );
    expect(first).toContain(
      ",GET,/api/pages,/api/pages,200,ok,12.500,pages,page.list,,one",
    );
    expect(second).toContain("500,server");
    expect(second).toContain('"He said ""no"", then =cmd"');
    expect(
      history
        .exportCsv({ ...range, outcomes: ["server"] })
        .trim()
        .split("\n"),
    ).toHaveLength(2);
  });

  it("does not let a cell start a spreadsheet formula", () => {
    const csv = tracesToCsv([
      {
        traceId: "t",
        name: "GET /x",
        endpoint: "GET /x",
        route: "=HYPERLINK(1)",
        generation: 1,
        startMs: NOW,
        status: "ok",
        truncated: false,
      },
    ]);
    expect(csv).toContain(",'=HYPERLINK(1),");
  });

  it("sorts by slowest and pages through results", async () => {
    const history = await open();
    for (let index = 0; index < 5; index++) {
      history.saveTrace(
        trace(`t${index}`, { agoMs: index, durationMs: index * 10 }),
      );
    }
    const range = { from: NOW - DAY, to: NOW };
    const first = history.traces({ ...range, sort: "slowest", limit: 2 });
    expect(first.total).toBe(5);
    expect(first.traces.map((item) => item.traceId)).toEqual(["t4", "t3"]);
    const second = history.traces({
      ...range,
      sort: "slowest",
      limit: 2,
      offset: 2,
    });
    expect(second.traces.map((item) => item.traceId)).toEqual(["t2", "t1"]);
  });

  it("summarizes how many requests match, how many failed, and how long they took", async () => {
    const history = await open();
    for (let index = 0; index < 10; index++) {
      history.saveTrace(
        trace(`list${index}`, {
          agoMs: index * 1_000,
          durationMs: (index + 1) * 10,
        }),
      );
    }
    history.saveTrace(
      trace("create", {
        agoMs: 2_000,
        method: "POST",
        httpStatus: 500,
        status: "error",
        durationMs: 300,
      }),
    );
    history.saveTrace(
      trace("gone", { agoMs: 3_000, httpStatus: 404, durationMs: 5 }),
    );
    history.saveTrace(trace("old", { agoMs: 40 * DAY }));
    const range = { from: NOW - 7 * DAY, to: NOW };

    const everything = history.summary(range);
    expect(everything).toMatchObject({
      total: 12,
      serverErrors: 1,
      clientErrors: 1,
    });
    // Durations: 5, 10, 20 ... 100, 300; the median sits between 50 and 60.
    expect(everything.medianMs).toBeCloseTo(55, 5);
    expect(everything.p95Ms).toBeGreaterThan(90);

    // The same filters as the list narrow it.
    const posts = history.summary({ ...range, methods: ["POST"] });
    expect(posts).toMatchObject({ total: 1, serverErrors: 1, clientErrors: 0 });
    expect(posts.medianMs).toBe(300);
    expect(history.summary({ ...range, minMs: 100 }).total).toBe(2);
  });

  it("summarizes nothing as zeros", async () => {
    const history = await open();
    expect(history.summary({ from: NOW - DAY, to: NOW })).toEqual({
      total: 0,
      clientErrors: 0,
      serverErrors: 0,
      medianMs: 0,
      p95Ms: 0,
    });
  });

  it("drops requests past retention and the oldest beyond the cap", async () => {
    const history = await open(30);
    history.saveTrace(trace("recent", { agoMs: DAY }));
    history.saveTrace(trace("stale", { agoMs: 31 * DAY }));
    history.flush();

    history.prune(NOW);
    expect(history.trace("recent")).toBeDefined();
    expect(history.trace("stale")).toBeUndefined();
  });

  it("ignores writes after it is closed", async () => {
    const history = await open();
    history.close();
    history.saveTrace(trace("late"));
    expect(() => history.close()).not.toThrow();
  });
});

describe("stored and live requests", () => {
  // The page filters live requests in JS and stored ones through SQL; both
  // must give the same answers for the same rows.
  const rows = [
    trace("ok", { agoMs: 9_000, durationMs: 12 }),
    trace("not-found", { agoMs: 8_000, httpStatus: 404, durationMs: 3 }),
    trace("teapot", { agoMs: 7_500, httpStatus: 418, path: "/api/tea_pot" }),
    trace("crash", { agoMs: 7_000, status: "error", httpStatus: 200 }),
    trace("bad-gateway", { agoMs: 6_000, httpStatus: 502, durationMs: 300 }),
    trace("no-status", { agoMs: 5_000, httpStatus: undefined }),
    trace("post", {
      agoMs: 4_000,
      method: "POST",
      route: "/api/pages/:id",
      service: "pages",
      action: "Pages.Create",
      durationMs: 80,
    }),
    trace("raw", {
      agoMs: 3_000,
      method: undefined,
      route: undefined,
      name: "websocket",
      message: "Wrong Password",
    }),
    trace("auth", { agoMs: 2_000, service: "auth", httpStatus: 401 }),
    trace("Zed", { agoMs: 1_000, service: "Zed", durationMs: 80 }),
  ];
  const window = { from: NOW - 10_000, to: NOW };
  const queries: HistoryQuery[] = [
    window,
    { ...window, outcomes: ["client"] },
    { ...window, outcomes: ["ok", "server"], methods: ["GET"] },
    { ...window, services: ["auth", "Zed"], sort: "slowest" },
    { ...window, endpoints: ["POST /api/pages/:id", "websocket"] },
    { ...window, minMs: 50, sort: "slowest" },
    { ...window, query: "pages.create" },
    { ...window, query: "wrong pass" },
    { ...window, query: "_pot" },
    { from: NOW - 6_500, to: NOW - 2_500 },
  ];

  it("agree on every filter, count, bucket and summary", async () => {
    const history = await open();
    for (const item of rows) history.saveTrace(item);
    const live = rows.map(toRow);
    for (const query of queries) {
      const inWindow = live.filter(
        (row) => row.startMs >= query.from && row.startMs <= query.to,
      );
      const matching = applyFilters(inWindow, query);
      expect(history.traces(query).traces.map((row) => row.traceId)).toEqual(
        matching.map((row) => row.traceId),
      );
      expect(history.facets(query)).toEqual(computeFacets(inWindow, query));
      expect(history.volume(query, 7)).toEqual(
        bucketRows(matching, query.from, query.to, 7),
      );
      expect(history.summary(query)).toEqual(summarizeRows(matching));
    }
  });
});

describe("under Node", () => {
  // Vite's dev server runs under Node, which has no bun:sqlite.
  const nodeVersion = Bun.spawnSync(["node", "--version"]).stdout.toString();
  const [major = 0, minor = 0] = nodeVersion
    .trim()
    .replace(/^v/, "")
    .split(".")
    .map(Number);
  // node:sqlite needs Node 22.5.
  const supported = major > 22 || (major === 22 && minor >= 5);

  it.skipIf(!supported)("saves and queries requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brick-node-history-"));
    directories.push(directory);
    // Bundle it first, as the package does, so Node runs plain JavaScript.
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/dev-history.ts")],
      outdir: join(directory, "bundle"),
      target: "node",
      format: "esm",
    });
    expect(built.success).toBe(true);
    const bundle = join(directory, "bundle", "dev-history.js");
    const script = `
      import { openHistory } from ${JSON.stringify(bundle)};
      const history = await openHistory({ directory: ${JSON.stringify(directory)}, days: 90 });
      const now = Date.now();
      history.saveTrace({ traceId: "n1", name: "GET /x", method: "GET", route: "/x", path: "/x",
        httpStatus: 200, generation: 1, startMs: now, endMs: now + 5, durationMs: 5,
        status: "ok", truncated: false, spans: [] });
      const found = history.traces({ from: now - 1000, to: now + 1000 });
      const summary = history.summary({ from: now - 1000, to: now + 1000 });
      history.close();
      console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node",
        total: found.total, endpoint: found.traces[0].endpoint, counted: summary.total }));
    `;
    const result = Bun.spawnSync(
      ["node", "--input-type=module", "-e", script],
      { stderr: "pipe" },
    );
    expect(result.stderr.toString()).not.toContain("Error");
    expect(result.stderr.toString()).not.toContain("ExperimentalWarning");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      runtime: "node",
      total: 1,
      endpoint: "GET /x",
      counted: 1,
    });
  });
});

describe("decodeHistoryQuery", () => {
  it("reads filters from a query string and ignores values it does not understand", () => {
    const query = decodeHistoryQuery(
      new URLSearchParams(
        "from=100&to=200&endpoint=GET%20%2Fx&endpoint=POST%20%2Fy&method=GET" +
          "&service=pages&outcome=server&outcome=client&outcome=weird" +
          "&minMs=50&q=pages&sort=slowest&limit=20&offset=40",
      ),
    );
    expect(query).toEqual({
      from: 100,
      to: 200,
      endpoints: ["GET /x", "POST /y"],
      methods: ["GET"],
      services: ["pages"],
      outcomes: ["server", "client"],
      minMs: 50,
      query: "pages",
      sort: "slowest",
      limit: 20,
      offset: 40,
    });

    const defaults = decodeHistoryQuery(
      new URLSearchParams({ outcome: "weird", from: "nope", minMs: "" }),
      NOW,
    );
    expect(defaults).toMatchObject({
      to: NOW,
      from: NOW - 7 * DAY,
      endpoints: undefined,
      outcomes: [],
      minMs: undefined,
      sort: "recent",
    });
  });
});
