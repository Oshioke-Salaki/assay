import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { NODE_ENV: "test" },
    testTimeout: 20_000,
  },
});
