import { describe, expect, it } from "bun:test";
import {
  initialState,
  parseRoute,
  reduce,
  routeHref,
} from "../dashboard/state";
import { docsHref } from "../src/dashboard-protocol";

describe("parseRoute", () => {
  it("reads a view and a selected request", () => {
    expect(parseRoute("#/requests")).toEqual({ view: "requests", path: [] });
    expect(parseRoute("#/requests/abc%20123")).toEqual({
      view: "requests",
      traceId: "abc 123",
      path: ["abc 123"],
    });
    expect(routeHref("requests", "abc 123")).toBe("#/requests/abc%20123");
  });

  it("knows the workflows view", () => {
    expect(parseRoute("#/workflows")).toEqual({ view: "workflows", path: [] });
  });

  it("falls back to requests for an address that is not a view", () => {
    // Old links, and anything else a page might put in the address.
    expect(parseRoute("")).toMatchObject({ view: "requests" });
    expect(parseRoute("#/analytics")).toMatchObject({ view: "requests" });
    expect(parseRoute("#tag/pages/POST/api/pages/echo")).toMatchObject({
      view: "requests",
    });
  });

  it("keeps the whole path of a docs page and the heading after it", () => {
    expect(parseRoute("#/docs")).toEqual({ view: "docs", path: [] });
    expect(parseRoute("#/docs/guides/add-a-tool")).toEqual({
      view: "docs",
      traceId: "guides",
      path: ["guides", "add-a-tool"],
    });
    expect(parseRoute("#/docs/architecture#routes")).toEqual({
      view: "docs",
      traceId: "architecture",
      path: ["architecture"],
      anchor: "routes",
    });
  });

  it("keeps working when part of the address is not valid encoding", () => {
    expect(parseRoute("#/docs/100%/done#half%")).toEqual({
      view: "docs",
      traceId: "100%",
      path: ["100%", "done"],
      anchor: "half%",
    });
  });

  it("keeps the whole path of an API operation", () => {
    expect(parseRoute("#/apis/pages-api/patch/api/page/%7Bid%7D")).toEqual({
      view: "apis",
      traceId: "pages-api",
      path: ["pages-api", "patch", "api", "page", "{id}"],
    });
  });
});

describe("docsHref", () => {
  it("builds the address of a page, and of a heading in it", () => {
    expect(docsHref([])).toBe("#/docs");
    expect(docsHref(["guides", "add a tool"])).toBe(
      "#/docs/guides/add%20a%20tool",
    );
    expect(docsHref(["architecture"], "routes")).toBe(
      "#/docs/architecture#routes",
    );
  });

  it("round-trips through parseRoute", () => {
    const route = parseRoute(docsHref(["a b", "c"], "d e"));
    expect(route).toMatchObject({
      view: "docs",
      path: ["a b", "c"],
      anchor: "d e",
    });
  });
});

describe("reduce", () => {
  it("follows the workflow inspector as the app restarts", () => {
    expect(initialState.inspector).toBe(false);
    const up = reduce(initialState, { type: "inspector", inspector: true });
    expect(up.inspector).toBe(true);
    expect(reduce(up, { type: "inspector", inspector: false }).inspector).toBe(
      false,
    );
  });
});
