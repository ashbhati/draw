import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createDrawMcpPlugin } from "./src/integrations/dev-bridge";

export default defineConfig({
  plugins: [react(), createDrawMcpPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
