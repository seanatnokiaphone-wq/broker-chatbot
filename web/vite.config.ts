import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.API_URL || "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
});
