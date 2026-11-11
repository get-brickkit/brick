// The project structure's file names, shared by the manifest and the lint.
// A leaf: the lint plugin bundles it to run under Node.

/** Definition file kinds: `<name>.<kind>.ts`. */
export const DEFINITION_KINDS = [
  "service",
  "events",
  "resource",
  "table",
  "action",
  "command",
  "tool",
  "socket",
  "listener",
  "schedule",
  "workflow",
  "step",
] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

/** The extensions a definition file may have. */
export const DEFINITION_EXTENSIONS = ["ts", "tsx", "mts", "js", "jsx", "mjs"];

/** A definition file name: the name, then the kind, then the extension. */
export const DEFINITION_FILE = new RegExp(
  `^(.*)\\.(${DEFINITION_KINDS.join("|")})\\.(${DEFINITION_EXTENSIONS.join("|")})$`,
);

/** A test file name: `*.test.ts`, `*.spec.mjs` and the like. */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The generated file that imports every definition file. */
export const MANIFEST_FILE = "services.gen.ts";
