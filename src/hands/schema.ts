import { allowedUploadRoots } from "../trust/uploads.js";
import { z } from "zod";
import { resolve as resolvePath, sep } from "node:path";
import type { Effect } from "./types.js";

/**
 * Refs are interpolated into a CSS attribute selector, so they must be
 * structurally incapable of escaping the quoted value. Anchored, digits only.
 */
export const RefSchema = z.string().regex(/^g\d+-r\d+$/, "malformed ref");

/** Only http(s). file:// would let an ungated navigate + readPage exfiltrate local files. */
const UrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), "only http(s) URLs are allowed");

/** Uploads are confined to one directory. Resolved first, so `..` cannot escape. */
/**
 * Where uploads may come from, read from trust/uploads.ts so there is ONE
 * definition of the rule.
 *
 * This used to be `<cwd>/documents` — a folder inside the checkout. Nothing
 * ever put a file there, and every résumé anyone actually owns lives in
 * ~/Documents, so the effect of the rule was not "uploads are restricted" but
 * "uploads never work". A constraint nobody can satisfy is not a safe default;
 * it is an untested code path that will be widened in a hurry the first time
 * someone needs it.
 *
 * Read at call time rather than captured at module load, so tests and users can
 * set CLIPPY_UPLOAD_ROOTS without import-order mattering.
 */
const UploadPathSchema = z
  .string()
  .transform((p) => resolvePath(p))
  .superRefine((p, ctx) => {
    const roots = allowedUploadRoots();
    if (roots.some((r) => p === r || p.startsWith(r + sep))) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `uploads must live under ${roots.join(", ")}`,
    });
  });

const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: UrlSchema }),
  z.object({ kind: z.literal("click"), ref: RefSchema }),
  z.object({ kind: z.literal("fill"), ref: RefSchema, value: z.string().max(10_000) }),
  z.object({ kind: z.literal("select"), ref: RefSchema, value: z.string().max(1_000) }),
  z.object({ kind: z.literal("upload"), ref: RefSchema, path: UploadPathSchema }),
  z.object({ kind: z.literal("submit"), ref: RefSchema }),
]);

/**
 * Validate a model-supplied effect at the `hands/` boundary.
 *
 * Everything reaching here originates from a model that read attacker-controlled
 * page text. Nothing past this point may assume any field is well-formed.
 */
export function parseEffect(input: unknown): Effect {
  return EffectSchema.parse(input) as Effect;
}
