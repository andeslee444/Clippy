import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });

// page-script.js is NOT TypeScript and tsc will not copy it. snapshot.js loads
// it from disk beside itself at runtime, so it has to land there. If this copy
// is ever dropped, readPage() fails at runtime with a confusing ENOENT rather
// than failing the build — hence the canary test.
mkdirSync("dist/hands/browser", { recursive: true });
copyFileSync("src/hands/browser/page-script.js", "dist/hands/browser/page-script.js");

// preload.cjs is CommonJS on purpose (Electron preload scripts don't support
// ESM) and the renderer is plain HTML/CSS/JS — tsc will not touch either.
mkdirSync("dist/shell/renderer", { recursive: true });
copyFileSync("src/shell/preload.cjs", "dist/shell/preload.cjs");
for (const f of ["index.html", "renderer.js", "styles.css"]) {
  copyFileSync(`src/shell/renderer/${f}`, `dist/shell/renderer/${f}`);
}

console.log("built to dist/");
