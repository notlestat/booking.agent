import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tool calls hit the network in the live-agent test; the unit tests are fast.
    testTimeout: 120_000,
  },
});
