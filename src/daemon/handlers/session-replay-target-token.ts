import { isTouchTargetCommand } from '../../replay/script-utils.ts';
import { splitIsSelectorArgs } from '../../selectors/index.ts';
import type { SessionAction } from '../types.ts';

/** Returns the resolved-target token carried by an eligible replay action. */
export function extractReplayTargetToken(action: SessionAction): string | undefined {
  const positionals = action.positionals ?? [];
  if (action.command === 'get') return positionals[1];
  // #1349: `is <predicate> <selector> [expected]` — the selector expression is
  // the target token (an `is exists` step is never annotated, so this only
  // runs for unique-resolving predicates).
  if (action.command === 'is') return splitIsSelectorArgs(positionals).split?.selectorExpression;
  if (!isTouchTargetCommand(action.command) && action.command !== 'fill') return undefined;
  const first = positionals[0];
  if (first === undefined) return undefined;
  if (isNumericToken(first) && isNumericToken(positionals[1])) return undefined;
  return first;
}

export function readRefLabel(action: SessionAction): string | undefined {
  const refLabel = action.result?.refLabel;
  return typeof refLabel === 'string' && refLabel.length > 0 ? refLabel : undefined;
}

function isNumericToken(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0 && !Number.isNaN(Number(value));
}
