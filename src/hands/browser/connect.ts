import { chromium, type Browser, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CLIPPY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/**
 * Deliberately NOT 9222. That port is the universal CDP default, so anything
 * else on the machine could be holding it — with the user's PRIMARY profile.
 * Attaching to that would put their email and bank one navigation away.
 */
const PORT = Number(process.env.CLIPPY_CDP_PORT ?? 9333);
/** Dedicated profile — NOT the user's primary Chrome data dir (spec §3.1). */
export const PROFILE_DIR = join(homedir(), ".clippy", "chrome-profile");

/** Launch the dedicated profile with the debugging port open. Detached: survives the CLI. */
export function launchChrome(): void {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (err) => {
    console.error(`Could not launch Chrome at ${CHROME}: ${err.message}`);
    console.error("Set CLIPPY_CHROME to the correct path.");
  });
  child.unref();
}

export interface Session {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

export class WrongProfileError extends Error {
  constructor(actual: string) {
    super(
      `Chrome on port ${PORT} is running profile "${actual}", not ${PROFILE_DIR}. ` +
        `Refusing to attach — this could be your primary browser. Close it and run with --launch.`,
    );
    this.name = "WrongProfileError";
  }
}

/** Attach to the dedicated profile, verifying it IS the dedicated profile. */
export async function connect(): Promise<Session> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (cause) {
    throw new Error(`No Chrome on port ${PORT}. Start it with: npm run spine -- --launch`, {
      cause,
    });
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Verify the profile before handing back anything that can act on it.
  const cdp = await context.newCDPSession(page);
  // CDP's Browser.getBrowserCommandLine returns { arguments: string[] }, not
  // { commandLine: ... } — confirmed against playwright-core's own shipped
  // Protocol.Browser.getBrowserCommandLineReturnValue type.
  const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
  const dirArg = args.find((a) => a.startsWith("--user-data-dir="));
  const actual = dirArg?.slice("--user-data-dir=".length) ?? "(unknown)";
  if (actual !== PROFILE_DIR) {
    await browser.close();
    throw new WrongProfileError(actual);
  }

  console.error(`attached: ${PROFILE_DIR} — ${page.url()}`);

  return {
    browser,
    page,
    // On a connectOverCDP browser, close() tears down OUR connection and leaves
    // Chrome running. That is what we want — the user's login sessions live in
    // that process and must survive the CLI exiting.
    close: async () => { await browser.close(); },
  };
}
