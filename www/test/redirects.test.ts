import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { docsPagePaths } from "../scripts/docs-pages";
import { redirectFor, redirects } from "../src/lib/redirects";

const pages = new Set(
  docsPagePaths(fileURLToPath(new URL("../content/docs", import.meta.url))),
);

test("every redirect lands on a live docs page in one hop", () => {
  for (const [from, to] of Object.entries(redirects)) {
    expect(pages.has(from)).toBe(false);
    expect(pages.has(to)).toBe(true);
  }
});

test("markdown twins follow their page", () => {
  expect(redirectFor("/docs/tools.md")).toBe("/docs/tools-and-mcp.md");
  expect(redirectFor("/docs/tools")).toBe("/docs/tools-and-mcp");
  expect(redirectFor("/docs/quickstart")).toBeUndefined();
});
