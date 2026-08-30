import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const clientDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(clientDirectory, "dist", "runtime");
const entries = {
  "daemon.mjs": "daemon.ts",
  "renderer.mjs": "renderer.ts",
  "toggl-waybar.mjs": "control-cli.ts",
  "drawer-controller.mjs": "drawer-controller.ts",
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  Object.entries(entries).map(([outputName, entryName]) =>
    build({
      absWorkingDir: clientDirectory,
      banner: {
        js: 'import { createRequire as __togglCreateRequire } from "node:module"; const require = __togglCreateRequire(import.meta.url);',
      },
      bundle: true,
      define: {
        "process.env.WS_NO_BUFFER_UTIL": "true",
        "process.env.WS_NO_UTF_8_VALIDATE": "true",
      },
      entryPoints: [`src/${entryName}`],
      format: "esm",
      logLevel: "silent",
      minifySyntax: true,
      outfile: resolve(outputDirectory, outputName),
      platform: "node",
      splitting: false,
      target: "node22",
    }),
  ),
);
