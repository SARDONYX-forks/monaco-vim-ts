import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/index.ts"),
      name: "monaco-vim",
      fileName: (format) => `monaco-vim.${format}.js`,
    },
    // sourcemap: true, // Necessary for live coming users to make the definition jump from JS to TS.
  },
});
