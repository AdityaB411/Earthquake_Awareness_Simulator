import { defineConfig } from "vite";

// Keep the development server limited to this machine by default.
export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,  },
});

