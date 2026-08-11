import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import type { RefTarget, SelectorTarget } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import type { FindLocator } from '@agent-device/selectors';

export { findNodeByLabel, resolveRefLabel } from '../../../core/snapshot-node-lookup.ts';

function shouldScopeFind(locator: string): boolean {
  return locator === 'text' || locator === 'label' || locator === 'any';
}

/** @internal Target helper used by tests/examples; runtime callers compose `ElementTarget` directly. */
export function selector(expression: string): SelectorTarget {
  return { kind: 'selector', selector: expression };
}

/** @internal Target helper used by tests/examples; runtime callers compose `ElementTarget` directly. */
export function ref(refInput: string, options: { fallbackLabel?: string } = {}): RefTarget {
  return {
    kind: 'ref',
    ref: refInput,
    ...(options.fallbackLabel ? { fallbackLabel: options.fallbackLabel } : {}),
  };
}

export function findSnapshotScope(
  platform: string,
  locator: FindLocator,
  query: string,
  selectorExpression: string | null,
): string | undefined {
  if (selectorExpression || platform === 'web') return undefined;
  return shouldScopeFind(locator) ? query : undefined;
}

export function sparseSelectorSnapshotError(verdict: SnapshotQualityVerdict): AppError {
  return new AppError('COMMAND_FAILED', 'find could not read the current accessibility tree', {
    reason: verdict.reason,
    hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth, navigate with coordinates if needed, then retry find after reaching a readable screen.',
  });
}
