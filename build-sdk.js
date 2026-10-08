// Bundles the Exotel CRM WebSDK into a single browser file: public/vendor/exotel-websdk.bundle.js
// Run with:  npm run build:sdk
// The core SDK imports .wav ringtones directly, so we inline them as data URIs.
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/exotel-websdk-entry.js"],
    bundle: true,
    format: "iife",
    globalName: "ExotelWebSDKBundle",
    outfile: "public/vendor/exotel-websdk.bundle.js",
    platform: "browser",
    target: ["es2018"],
    minify: true,
    sourcemap: false,
    logLevel: "info",
    loader: { ".wav": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
  })
  .then(() => console.log("[build-sdk] Exotel WebSDK bundled -> public/vendor/exotel-websdk.bundle.js"))
  .catch((e) => {
    console.error("[build-sdk] Failed to bundle Exotel WebSDK:", e);
    process.exit(1);
  });
