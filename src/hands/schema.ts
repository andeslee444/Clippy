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
export const UPLOAD_ROOT = resolvePath(process.cwd(), "documents");

const UploadPathSchema = z
  .string()
  .transform((p) => resolvePath(p))
  .refine((p) => p === UPLOAD_ROOT || p.startsWith(UPLOAD_ROOT + sep), {
    message: `uploads must live under ${UPLOAD_ROOT}`,
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
