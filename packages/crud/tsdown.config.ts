import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/index.ts"],
  dts: true,
  // Resolve core from its built types so TS 7 does not emit core sources.
  tsconfig: "tsconfig.build.json",
  format: ["esm"],
  platform: "node",
  fixedExtension: false,
});
