import type { RefTarget, SelectorTarget } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotQualityVerdict } from '../../../snapshot/snapshot-quality.ts';
import type { FindLocator } from '../../../selectors/find.ts';
import type { SelectorChain } from '../../../selectors/parse.ts';

export { findNodeByLabel, resolveRefLabel } from '../../../snapshot/snapshot-processing.ts';

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
  selectorChain: SelectorChain | null,
): string | undefined {
  if (selectorChain || platform === 'web') return undefined;
  return shouldScopeFind(locator) ? query : undefined;
}

export function sparseSelectorSnapshotError(verdict: SnapshotQualityVerdict): AppError {
  return new AppError('COMMAND_FAILED', 'find could not read the current accessibility tree', {
    reason: verdict.reason,
    hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth, navigate with coordinates if needed, then retry find after reaching a readable screen.',
  });
}
