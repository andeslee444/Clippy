import { TOOL_META, type Action } from "../hands/types.js";

/**
 * The safety boundary (spec §7.1).
 *
 * Returns true if `action` must not execute until a human has approved it.
 *
 * MUST be a pure function of the action's static TOOL_META. Never consult a
 * model, the page, or run state here — a confused or prompt-injected model has
 * to be structurally unable to reach an ungated Submit.
 *
 * TODO(author): implement. See Plan 1, Task 3 for the trade-offs.
 */
export function isGated(action: Action): boolean {
  void TOOL_META;
  void action;
  throw new Error("isGated not implemented — see docs/superpowers/plans, Task 3");
}
