import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The shadcn components import this package by its own name (`@erp/ui/lib/utils`), as components.json says.
    alias: [{ find: /^@erp\/ui\/(lib|components|hooks)\/(.*)$/, replacement: fileURLToPath(new URL("./src/$1/$2", import.meta.url)) }],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
});
