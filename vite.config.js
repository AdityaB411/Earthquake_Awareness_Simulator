import { defineConfig } from "vite";

// Keep development and preview servers bound to this machine by default.
export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});
