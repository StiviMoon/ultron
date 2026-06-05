import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/daemon/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  banner: { js: "#!/usr/bin/env node" },
  external: ["better-sqlite3", "sqlite-vec", "@huggingface/transformers"],
});
