import { defineConfig } from "vite";

// Make the Vite development server accessible on all hosts
// (for reverse proxies and alternate domains).
export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Allow all hosts for testing and alternate domains
    allowedHosts: true,
  },
});

