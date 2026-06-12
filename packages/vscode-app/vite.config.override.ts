import { defineConfig } from "vite"
import { fileURLToPath } from "url"
import defaultConfig from "../app/vite.config.js"

export default defineConfig({
  ...defaultConfig,
  resolve: {
    ...(defaultConfig.resolve ?? {}),
    alias: {
      ...((defaultConfig.resolve?.alias ?? {}) as Record<string, string>),
      "@/components/debug-bar": fileURLToPath(
        new URL("../app/src/vscode/debug-bar-stub.tsx", import.meta.url),
      ),
    },
  },
})
