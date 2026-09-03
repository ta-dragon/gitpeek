/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  /*
   * Shiki の文法と wasm は**遅延読み込みの別チャンク**になる（docs/DESIGN.md §7.2）。
   * 大きいのは承知の上なので、既定の 500KB では毎回警告が出て意味を成さない。
   * **起動時に読むチャンク（index）が増えたら気付きたい**ので、無効にはしない。
   */
  build: { chunkSizeWarningLimit: 900 },

  // テストするのは純関数だけなので DOM は要らない（docs/DESIGN.md §14.4）。
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
