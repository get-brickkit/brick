import { fileURLToPath } from "node:url";

/** The path of a module of this package beside this one: its source, or its build in dist. */
export const ownModule = (name: string): string =>
  fileURLToPath(
    new URL(
      `./${name}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
      import.meta.url,
    ),
  );
