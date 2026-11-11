import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `pnpm dev:web` proxies the API to a running `mingle start`.
    proxy: { "/v1": `http://127.0.0.1:${process.env.MINGLE_PORT ?? 7419}` },
  },
});
