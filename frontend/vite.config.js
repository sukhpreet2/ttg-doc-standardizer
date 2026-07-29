import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// In dev, proxy /api and health routes to the backend on :4000.
// In production the nginx image serves the SPA and proxies /api to the backend service.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/api": { target: "http://localhost:4000", changeOrigin: true },
        },
    },
});
