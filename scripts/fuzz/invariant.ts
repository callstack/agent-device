// The invariants the parser fuzz lane enforces (#1414, validation targets #1781 B2).
//
// Parsers are the front door for agent-authored input. For classic targets the contract is not
// "parses correctly" (nobody can say what a mutated string should mean) but "fails well":
//
//   1. a rejection is an `AppError` — never a bare Error, TypeError, string, or undefined;
//   2. the normalized error carries a non-empty `hint`, so the caller is told what to do;
//   3. the case terminates — enforced by the harness watchdog, not by this module, because
//      synchronous parsers cannot be interrupted from inside their own tick.
//
// A validation target (`target.check`) additionally knows what each case SHOULD do, because its
// generator constructed the case with a planted violation or none: it judges silent acceptances
// and wrong error codes too (validation-case.ts).

import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { FuzzFailure, FuzzTarget } from './target-types.ts';

// Re-exported because every existing consumer imports the failure type from the invariant it
// belongs to; the declaration moved to target-types.ts only to keep targets cycle-free.
export type { FuzzFailure };

/**
 * Runs one case and returns the invariant violation it produced, or `null`.
 * For classic targets, accepting the parse is a pass: they judge rejections, not results.
 * A validation target owns its whole judgment via `check`.
 */
export function checkCase(target: FuzzTarget, input: string): FuzzFailure | null {
  if (target.check) return target.check(input);
  try {
    target.run(input);
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) {
      return {
        target: target.name,
        input,
        kind: 'untyped-throw',
        detail: describeThrown(error),
      };
    }
    const hint = normalizeError(error).hint;
    if (typeof hint !== 'string' || hint.trim().length === 0) {
      return {
        target: target.name,
        input,
        kind: 'empty-hint',
        detail: `AppError ${error.code} has no hint: ${error.message}`,
      };
    }
    return null;
  }
}

export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const stackLine = error.stack?.split('\n')[1]?.trim();
    return `${error.name}: ${error.message}${stackLine ? ` (at ${stackLine})` : ''}`;
  }
  return `non-Error throw: ${typeof error} ${String(error)}`;
}

export function describeFailure(failure: FuzzFailure): string {
  return `[${failure.target}] ${failure.kind}: ${failure.detail}`;
}
