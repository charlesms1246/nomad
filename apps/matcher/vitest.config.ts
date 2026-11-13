import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@nomad/agent": r("../agent/src/index.ts"),
      "@nomad/ringfinder": r("../../packages/ringfinder/src/index.ts"),
      "@nomad/intents": r("../../packages/intents/src/index.ts"),
      "@nomad/verifier-model": r("../../packages/verifier-model/src/index.ts"),
      "@nomad/oneclick": r("../../packages/oneclick/src/index.ts"),
      "@nomad/colo": r("../../packages/colo/src/index.ts"),
    },
  },
});
