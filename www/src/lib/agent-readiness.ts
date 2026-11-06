import { isMarkdownPreferred } from "fumadocs-core/negotiation";

export const homepageMarkdown = `# Brick TypeScript backend framework

Brick is a TypeScript backend framework for Bun. Define services, actions, resources, and MCP tools with typed schemas.

## When to use Brick

Use Brick to build typed backend APIs on Bun, expose service actions through HTTP or MCP, and define database resources with Drizzle. Start with the documentation before generating code. Brick is a framework you install in your project; this website is not a hosted execution API.

- [Brick API documentation](https://www.brickkit.dev/docs)
- [Agent documentation index](https://www.brickkit.dev/llms.txt)
- [Website OpenAPI specification](https://www.brickkit.dev/openapi.json)
- [GitHub organization](https://github.com/get-brickkit)
`;

export function markdownNotFound() {
  return new Response(
    "# Page not found\n\nThe requested page does not exist. Find available pages in the [documentation](/docs) or [agent index](/llms.txt).\n",
    {
      status: 404,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept",
      },
    },
  );
}

export function agentResponse<T extends { response: Response }>(
  request: Request,
  result: T,
): T | Response {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/") && result.response.status >= 400) {
    return Response.json(
      {
        error: {
          code: `HTTP_${result.response.status}`,
          message: "The API request could not be completed.",
          hint: "Check the request method and parameters in /openapi.json. For framework APIs, consult /docs.",
        },
      },
      { status: result.response.status },
    );
  }
  if (
    [404, 406].includes(result.response.status) &&
    isMarkdownPreferred(request, { markdownMediaTypes: ["text/markdown"] })
  )
    return markdownNotFound();
  if (path === "/" || result.response.status === 404) {
    const vary = result.response.headers.get("Vary");
    result.response.headers.set("Vary", vary ? `${vary}, Accept` : "Accept");
  }
  return result;
}

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Brick website documentation API",
    version: "1.0.0",
    description:
      "Public documentation discovery resources. Applications built with Brick generate their own OpenAPI specifications; this specification describes this website only. The interactive search and chat endpoints are UI integrations, not stable public APIs.",
  },
  servers: [{ url: "https://www.brickkit.dev" }],
  paths: Object.fromEntries(
    [
      [
        "/llms.txt",
        "getDocumentationIndex",
        "Read the index of Brick documentation and agent guidance.",
      ],
      [
        "/llms-full.txt",
        "getFullDocumentation",
        "Read the complete Brick documentation as Markdown.",
      ],
      [
        "/",
        "getProductOverview",
        "Read the Brick framework overview. Request text/markdown for agent consumption.",
      ],
    ].map(([path, operationId, description]) => [
      path,
      {
        get: {
          operationId,
          description,
          responses: {
            "200": {
              description: "Documentation content",
              content: { "text/markdown": { schema: { type: "string" } } },
            },
          },
        },
      },
    ]),
  ),
};
