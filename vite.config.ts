import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/llm-wiki": {
        target: process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:19828",
        changeOrigin: true,
        headers: process.env.LLM_WIKI_API_TOKEN
          ? { Authorization: `Bearer ${process.env.LLM_WIKI_API_TOKEN}` }
          : undefined,
        rewrite: (path) => path.replace(/^\/api\/llm-wiki/, "/api/v1"),
      },
    },
  },
});
