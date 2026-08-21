import { chromium, type Browser, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;
/** Dedicated profile — NOT the user's primary Chrome data dir (spec §3.1). */
export const PROFILE_DIR = join(homedir(), ".clippy", "chrome-profile");

/** Launch the dedicated profile with the debugging port open. Detached: survives the CLI. */
export function launchChrome(): void {
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ], { detached: true, stdio: "ignore" });
  child.unref();
}

export interface Session {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

/** Attach to the already-running dedicated profile. Throws with guidance if it isn't up. */
export async function connect(): Promise<Session> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (cause) {
    throw new Error(
      `No Chrome on port ${PORT}. Start it with: npm run spine -- --launch`,
      { cause },
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    browser,
    page,
    // On a connectOverCDP browser, close() tears down OUR connection and leaves
    // Chrome running. That is what we want — the user's login sessions live in
    // that process and must survive the CLI exiting.
    close: async () => { await browser.close(); },
  };
}
