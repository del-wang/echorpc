import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    server: {
      host: true,
      port: 5176,
      strictPort: true,
    },
  };
});
