import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __ENGINE_VERSIONS__: JSON.stringify({
      webllm: "test",
      transformersjs: "test",
      wllama: "test",
    }),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
