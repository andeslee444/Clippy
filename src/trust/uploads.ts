import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Refused because the file is outside every allowed root.
 *
 * A distinct type so the executor can report it as a tool result the model can
 * read, rather than an unexplained failure it will retry.
 */
export class UploadRefusedError extends Error {
  constructor(path: string, why: string) {
    super(`refused to upload ${path}: ${why}`);
    this.name = "UploadRefusedError";
  }
}

/**
 * Directories an upload may come from. `~/Documents` by default.
 *
 * Configurable, because the default is a guess about where people keep
 * résumés — but configurable to a LIST of roots, never to "anywhere". There is
 * deliberately no value of CLIPPY_UPLOAD_ROOTS meaning unrestricted.
 */
export function allowedUploadRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.CLIPPY_UPLOAD_ROOTS?.split(":").filter(Boolean);
  return (configured?.length ? configured : [join(homedir(), "Documents")]).map((r) => resolve(r));
}

/**
 * Resolve `path` and confirm it sits inside an allowed root, or throw.
 *
 * Returns the REAL path, and callers must upload the returned value rather than
 * the argument. Both halves matter, and for the same reason: `realpathSync`
 * resolves symlinks before the comparison, so a link planted at
 * `~/Documents/resume.pdf` pointing at `~/.ssh/id_rsa` resolves outside the
 * root and is refused. Checking the string and then uploading the original
 * would be a check-then-use race that this defeats by construction — there is
 * only one path, and it is the resolved one.
 *
 * A prefix test alone is not enough either: `~/Documents-secret` starts with
 * `~/Documents`. Hence the explicit separator.
 */
export function assertUploadAllowed(path: string, roots = allowedUploadRoots()): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new UploadRefusedError(path, "no such file");
  }

  const inside = roots.some((root) => {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return false; // A configured root that does not exist allows nothing.
    }
    return real === realRoot || real.startsWith(realRoot + sep);
  });

  if (!inside) {
    throw new UploadRefusedError(path, `outside the allowed folder(s): ${roots.join(", ")}`);
  }
  return real;
}
