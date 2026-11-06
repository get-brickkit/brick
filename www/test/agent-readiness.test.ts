import { expect, test } from "bun:test";
import {
  agentResponse,
  homepageMarkdown,
  markdownNotFound,
  openapi,
} from "../src/lib/agent-readiness";

test("missing pages return useful Markdown with 404 and cache variation", async () => {
  const response = markdownNotFound();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  expect(response.headers.get("vary")).toBe("Accept");
  expect(await response.text()).toContain("[documentation](/docs)");
});
test("API errors have structured resolution guidance", async () => {
  const response = agentResponse(
    new Request("https://www.brickkit.dev/api/missing"),
    { response: new Response("HTML", { status: 404 }) },
  );
  expect(response).toBeInstanceOf(Response);
  if (response instanceof Response)
    expect(await response.json()).toEqual({
      error: {
        code: "HTTP_404",
        message: "The API request could not be completed.",
        hint: "Check the request method and parameters in /openapi.json. For framework APIs, consult /docs.",
      },
    });
});
test("HTML homepage remains intact and varies by Accept", () => {
  const result = { response: new Response("<html>Brick</html>") };
  expect(
    agentResponse(
      new Request("https://www.brickkit.dev/", {
        headers: { Accept: "text/html" },
      }),
      result,
    ),
  ).toBe(result);
  expect(result.response.headers.get("vary")).toBe("Accept");
  expect(homepageMarkdown).toContain("## When to use Brick");
});
test("discovery operations have unique IDs, descriptions and typed responses", () => {
  const ids = Object.values(openapi.paths).map(({ get }) => {
    expect(get.description.length).toBeGreaterThan(20);
    expect(get.responses["200"].content["text/markdown"].schema.type).toBe(
      "string",
    );
    return get.operationId;
  });
  expect(new Set(ids).size).toBe(ids.length);
});
