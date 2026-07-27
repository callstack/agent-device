// The single invariant the parser fuzz lane enforces (#1414).
//
// Parsers are the front door for agent-authored input, so the contract is not "parses
// correctly" (nobody can say what a mutated string should mean) but "fails well":
//
//   1. a rejection is an `AppError` — never a bare Error, TypeError, string, or undefined;
//   2. the normalized error carries a non-empty `hint`, so the caller is told what to do;
//   3. the case terminates — enforced by the harness watchdog, not by this module, because
//      synchronous parsers cannot be interrupted from inside their own tick.

import { AppError, normalizeError } from '../../src/kernel/errors.ts';
import type { FuzzTarget, FuzzTargetName } from './target-types.ts';

export type FuzzFailureKind = 'untyped-throw' | 'empty-hint' | 'hang';

export type FuzzFailure = {
  target: FuzzTargetName;
  input: string;
  kind: FuzzFailureKind;
  detail: string;
};

/**
 * Runs one case and returns the invariant violation it produced, or `null`.
 * Accepting the parse is a pass: the lane judges rejections, not results.
 */
export function checkCase(target: FuzzTarget, input: string): FuzzFailure | null {
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

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const stackLine = error.stack?.split('\n')[1]?.trim();
    return `${error.name}: ${error.message}${stackLine ? ` (at ${stackLine})` : ''}`;
  }
  return `non-Error throw: ${typeof error} ${String(error)}`;
}

export function describeFailure(failure: FuzzFailure): string {
  return `[${failure.target}] ${failure.kind}: ${failure.detail}`;
}
