import type { SessionAction } from '@agent-device/contracts/session';
import { isTouchTargetCommand } from '@agent-device/ad-script';
import { dragGesturePayloadFromPositionals } from '@agent-device/contracts/gesture-normalization';
import { readSelectorExpression } from '@agent-device/selectors';

/** Returns the resolved-target token carried by an eligible replay action. */
export function extractReplayTargetToken(
  action: SessionAction,
  targetRole?: 'source' | 'destination',
): string | undefined {
  const positionals = action.positionals ?? [];
  if (action.command === 'gesture') {
    const drag = dragGesturePayloadFromPositionals(positionals);
    return drag ? drag[targetRole ?? 'source'] : undefined;
  }
  if (action.command === 'get') return positionals[1];
  // #1349: `is <predicate> <selector> [expected]` — the selector expression is
  // the target token (an `is exists` step is never annotated, so this only
  // runs for unique-resolving predicates).
  if (action.command === 'is') {
    const outcome = readSelectorExpression('is', positionals);
    return outcome.kind === 'expression' ? outcome.expression : undefined;
  }
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
