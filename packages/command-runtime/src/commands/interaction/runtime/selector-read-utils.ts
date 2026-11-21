import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import type {
  InteractionRefTarget,
  InteractionSelectorTarget,
} from '@agent-device/contracts/interaction';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { FindLocator } from '@agent-device/selectors';

export { findNodeByLabel, resolveRefLabel } from '@agent-device/capture-kit/snapshot-node-lookup';

/** Why `find` refuses a capture that cannot be read as the screen. */
export const FIND_READ_REASONS = {
  // The capture came back sparse, so no selector could be resolved against it.
  snapshotUnreadable: { reason: 'find_snapshot_unreadable' },
} as const satisfies ReasonTable<'find'>;

function shouldScopeFind(locator: string): boolean {
  return locator === 'text' || locator === 'label' || locator === 'any';
}

/** @internal Target helper used by tests/examples; runtime callers compose `InteractionElementTarget` directly. */
export function selector(expression: string): InteractionSelectorTarget {
  return { kind: 'selector', selector: expression };
}

/** @internal Target helper used by tests/examples; runtime callers compose `InteractionElementTarget` directly. */
export function ref(
  refInput: string,
  options: { fallbackLabel?: string } = {},
): InteractionRefTarget {
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
    reason: FIND_READ_REASONS.snapshotUnreadable.reason,
    verdictReason: verdict.reason,
    verdictReasonCode: verdict.reasonCode,
    hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth, navigate with coordinates if needed, then retry find after reaching a readable screen.',
  });
}
