import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          RELAY_TOKEN: "test-relay-token",
          TOGGL_USER_ID: "303",
          TOGGL_WEBHOOK_SECRET: "test-webhook-secret",
        },
      },
    }),
  ],
});
