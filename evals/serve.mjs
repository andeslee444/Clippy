// evals/serve.mjs
//
// A minimal static file server for evals/fixtures/, on a fixed port (8787).
//
// Deliberately HTTP, not file://. Clippy's schema validation (src/hands/schema.ts,
// UrlSchema) rejects non-http(s) URLs by design — that rejection is itself under
// test in F4 (the hostile fixture's file:///etc/passwd link), and a file:// origin
// for the fixtures themselves would make that assertion meaningless: everything
// would already be same-origin with the local filesystem. Serving over a real
// HTTP origin is what makes "never leaves http(s)" a real boundary to cross.
//
// No dependencies beyond node:http/node:fs — this only ever serves eight known,
// trusted, self-authored fixture files.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PORT = 8787;

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const FIXTURES_DIR = join(HERE, "fixtures");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * Resolve a request path to a file under FIXTURES_DIR, refusing anything that
 * would escape it. Mirrors the containment check schema.ts applies to upload
 * paths (resolve, then require the result to still start with the root) —
 * same shape of defense, different boundary.
 */
function resolveFixturePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const clean = decoded === "/" ? "/f1-cold-apply.html" : decoded;
  const target = normalize(join(FIXTURES_DIR, clean));
  if (target !== FIXTURES_DIR && !target.startsWith(FIXTURES_DIR + sep)) {
    return null;
  }
  return target;
}

export function createFixtureServer() {
  return createServer(async (req, res) => {
    const path = resolveFixturePath(req.url ?? "/");
    if (!path) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad path");
      return;
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      const body = await readFile(path);
      const type = CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "content-length": body.length });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${req.url}`);
    }
  });
}

/** Start listening on PORT, resolving once the server is actually up. */
export function startFixtureServer(port = PORT) {
  const server = createFixtureServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Runnable directly: `node evals/serve.mjs` — useful for manually curling a
// fixture without going through the full eval runner.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = await startFixtureServer();
  console.log(`serving ${FIXTURES_DIR} on http://127.0.0.1:${PORT}`);
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
}
