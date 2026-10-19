import { defineConfig } from "vite";

// Make the Vite development server accessible on all hosts
// (for reverse proxies and alternate domains).
export default defineConfig({
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Allow all hosts for testing and alternate domains
    allowedHosts: true,
  },
});

