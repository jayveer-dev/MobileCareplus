import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// Two windows: the main app (index) and the Transfer module (transfer), each with its own preload.
const pages = (dir: string, ext: string) => ({ index: resolve(__dirname, dir, `index${ext}`), transfer: resolve(__dirname, dir, `transfer${ext}`) });

export default defineConfig({
  main: {},
  preload: { build: { rollupOptions: { input: pages("src/preload", ".ts") } } },
  renderer: { build: { rollupOptions: { input: pages("src/renderer", ".html") } }, plugins: [react()] },
});
