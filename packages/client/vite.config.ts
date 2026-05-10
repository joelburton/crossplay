import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const clientPort = Number(process.env.PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: clientPort,
    strictPort: true,
    headers: {
      "Cache-Control": "no-store",
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
        rewrite: (p) => p.replace(/^\/ws/, ""),
      },
    },
  },
});
