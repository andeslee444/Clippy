// evals/run.mjs — `npm run eval` entry point.
//
// This file is deliberately tiny. Its only job is to register tsx's ESM
// loader BEFORE anything imports from src/**/*.ts, then hand off to
// evals/harness.mjs, which does the real work.
//
// Why a two-file split instead of one: static `import` statements are
// resolved before any code in a module runs, so a single file cannot both
// `register()` the TypeScript loader and statically `import` a .ts module —
// the import would already have failed to resolve by the time register()
// executes. Splitting into a bootstrap (this file, run via plain `node`) and
// an implementation module (dynamically imported only after the loader is in
// place) is the standard way around that; see tsx's own docs for `tsImport`.
//
// This keeps `"eval": "node evals/run.mjs"` in package.json exactly as
// specified, with no `tsx` on the command line and no build step required.

import { register } from "tsx/esm/api";

register();

const { main } = await import("./harness.mjs");
await main();
