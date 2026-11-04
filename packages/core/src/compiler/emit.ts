import type { RouteIR } from "./ir";

/** Emits framework code only. User callbacks remain closures bound separately. */
export function emitHandlerFactory(route: RouteIR): string {
  const name = JSON.stringify(route.action);
  const fields = route.input
    ? "params, body, query, headers, request, set"
    : "headers, request, set";
  const input: string[] = ["let input;"];
  if (route.input) {
    input.push("let coercedQuery = query;");
    if (route.coercions.length) {
      input.push("if (query) {", "coercedQuery = { ...query };");
      for (const [index, coercion] of route.coercions.entries()) {
        const key = JSON.stringify(coercion.key);
        input.push(`const v${index} = query[${key}];`);
        if (coercion.type === "number")
          input.push(
            `if (v${index} !== undefined) { const n${index} = Number(v${index}); if (!Number.isNaN(n${index})) coercedQuery[${key}] = n${index}; }`,
          );
        else if (coercion.type === "array")
          input.push(
            `if (v${index} !== undefined) { const values${index} = request ? new URL(request.url).searchParams.getAll(${key}) : []; coercedQuery[${key}] = values${index}.length ? values${index} : Array.isArray(v${index}) ? v${index} : [v${index}]; }`,
          );
        else
          input.push(
            `if (v${index} === "true" || v${index} === "1") coercedQuery[${key}] = true; else if (v${index} === "false" || v${index} === "0") coercedQuery[${key}] = false;`,
          );
      }
      input.push("}");
    }
    input.push("let coercedParams = params;");
    const numeric = route.coercions.filter(({ type }) => type === "number");
    if (numeric.length) {
      // Path segments are strings; numeric ids (`/:id`) need numbers.
      input.push("if (params) {", "coercedParams = { ...params };");
      for (const [index, coercion] of numeric.entries()) {
        const key = JSON.stringify(coercion.key);
        input.push(
          `const p${index} = params[${key}]; if (typeof p${index} === "string") { const pn${index} = Number(p${index}); if (!Number.isNaN(pn${index})) coercedParams[${key}] = pn${index}; }`,
        );
      }
      input.push("}");
    }
    input.push(
      `input = mergeInput(${route.inputPrecedence.map((source) => (source === "query" ? "coercedQuery" : source === "params" ? "coercedParams" : source)).join(", ")});`,
    );
    if ((route.inputSchema as { type?: string } | undefined)?.type === "object")
      input.push("input ??= {};");
  }
  const asyncStages = route.context || route.authorize;
  const context = route.context
    ? "const extra = await contextHook(ctx); if (extra) Object.assign(ctx, extra);"
    : "";
  const validation = route.input
    ? `checkDepth(input, ${name}); validate(inputChecker, input, ${name}, "input");`
    : "";
  const authorization = route.authorize
    ? `if (!await authorize({ ctx, input, user: ctx.user })) deny(${name}, ctx.user);`
    : "";
  const output = route.output
    ? `validate(outputChecker, result, ${name}, "output");`
    : "";
  const execute = asyncStages
    ? `const result = await execute({ input, ctx, error: errorBuilder });\n${output}\nreturn result;`
    : `const result = execute({ input, ctx, error: errorBuilder });
if (isThenable(result)) return Promise.resolve(result).then(value => {
  ${route.output ? `validate(outputChecker, value, ${name}, "output");` : ""}
  return value;
}).catch(err => mapError(err, set, ctx));
${output}
return result;`;
  return `function bindAction(binding, runtime) {
const { execute, contextHook, authorize, inputChecker, outputChecker, errorBuilder, logger, cachedDb, service } = binding;
const { nextSequence, defaultRequest, emptyServices, mergeInput, checkDepth, validate, deny, mapError, isThenable } = runtime;
return ${asyncStages ? "async " : ""}function brickAction({ ${fields} }) {
const seq = nextSequence();
const traceId = (headers && headers["x-trace-id"]) || "tr_" + seq;
const requestId = (headers && headers["x-request-id"]) || "req_" + seq;
if (set?.headers) { set.headers["x-trace-id"] = traceId; set.headers["x-request-id"] = requestId; }
${input.join("\n")}
const ctx = { request: request instanceof Request ? request : defaultRequest, traceId, requestId,
  db: cachedDb ?? service.getDb(), logger, services: emptyServices, deps: service.deps ?? emptyServices, metadata: { headers }, _resolved: true };
try {
${context}
${validation}
${authorization}
${execute}
} catch (err) { return mapError(err, set, ctx); }
};
}`;
}
