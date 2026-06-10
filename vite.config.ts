import { defineConfig } from "vite";

// Single-page app; base "./" so the static build can be served from any path.
export default defineConfig({
  base: "./",
  build: { target: "es2022", sourcemap: true },
});
