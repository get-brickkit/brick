export const redirects: Record<string, string> = {
  "/benchmarks": "/docs/why-brick",
  "/docs/benchmarking": "/docs/why-brick",
  "/docs/contributing/benchmarking": "/docs/why-brick",
  "/docs/effect-runtime": "/docs/services-and-actions",
  "/docs/effect-setup": "/docs/services-and-actions",
  "/docs/getting-started": "/docs/quickstart",
  "/docs/child-tables": "/docs/relations",
  "/docs/singletons": "/docs/relations",
  "/docs/codegen": "/docs/type-inference",
  "/docs/migrations": "/docs/database",
  "/docs/tools": "/docs/tools-and-mcp",
  "/docs/validate-hook": "/docs/validation-and-errors",
  "/docs/brick-cli/generate": "/docs/brick-cli/gen",
  "/docs/brick-cli/migrate": "/docs/database",
  "/docs/brick-cli/schema-dump": "/docs/brick-cli/info",
};

export function redirectFor(path: string): string | undefined {
  const md = path.endsWith(".md");
  const target = redirects[md ? path.slice(0, -3) : path];
  return target && (md ? `${target}.md` : target);
}
