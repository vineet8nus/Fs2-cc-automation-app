import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // orchestrator.test.ts and e2e.test.ts both drive real git operations
    // against the same shared server/data/abap-mirror working directory
    // (gitSyncAgent.ts's MIRROR_ROOT). Running test files in parallel
    // workers races checkout/write/commit against that one directory and
    // corrupts it (ENOENT mid-run) — sequential file execution is required
    // here, not just a nice-to-have.
    fileParallelism: false,
  },
});
