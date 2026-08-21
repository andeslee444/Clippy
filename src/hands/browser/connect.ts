import { chromium, type Browser, type Page } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
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

/**
 * The `--user-data-dir` of whatever process is listening on `port`, or null.
 *
 * Asks the OS rather than Chrome. `Browser.getBrowserCommandLine` would be the
 * obvious route, but it refuses unless Chrome was launched with
 * `--enable-automation` — which sets `navigator.webdriver` and shows the
 * automation infobar. Those are exactly the bot-detection signals a real
 * logged-in profile exists to avoid (spec §3.1), so buying profile verification
 * with that flag would cost the thing it protects.
 */
export function profileBehindPort(port: number): string | null {
  try {
    const pid = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
    if (!pid) return null;
    const cmd = execFileSync("ps", ["-p", pid, "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return cmd.match(/--user-data-dir=(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Attach to the dedicated profile, verifying it IS the dedicated profile. */
export async function connect(): Promise<Session> {
  // Verify BEFORE opening a connection: never hold a CDP handle on a browser we
  // are about to refuse.
  const actual = profileBehindPort(PORT);
  if (actual === null) {
    throw new Error(`No Chrome on port ${PORT}. Start it with: npm run spine -- --launch`);
  }
  if (actual !== PROFILE_DIR) throw new WrongProfileError(actual);

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

  console.error(`attached: ${PROFILE_DIR} — ${page.url()}`);

  return {
    browser,
    page,
    // On a connectOverCDP browser, close() tears down OUR connection and leaves
    // Chrome running. That is what we want — the user's login sessions live in
    // that process and must survive the CLI exiting.
    close: async () => {
      await browser.close();
    },
  };
}
