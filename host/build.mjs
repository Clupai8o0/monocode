import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["host/cli.ts"],
  outfile: "build/host/monocode-host.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text" },
  define: {
    "import.meta.hot": "undefined",
    // The phone protocol reuses desktop transcript code, which reads Vite's env.
    "import.meta.env": JSON.stringify({ MODE: "production", DEV: false, PROD: true }),
  },
  sourcemap: true,
  // CommonJS dependencies (qrcode) require Node built-ins at run time.
  banner: {
    js: 'import { createRequire as __hostRequire } from "node:module"; const require = __hostRequire(import.meta.url);',
  },
});
await copyFile("host/provider-guard.mjs", "build/host/provider-guard.mjs");
