import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  ElementTextRuntimeOperations,
  ElementTextUnreadableReason,
} from '@agent-device/contracts/element-text-runtime';
import { isIosFamily } from '@agent-device/kernel/device';
import { runtimeExecutionFromContext } from '../snapshot-runtime-capture-input.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { SessionState } from '../types.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { extractReadableText, prefersValueForReadableText } from '../../utils/text-surface.ts';
import type { ContextFromFlags } from './interaction-common.ts';
import { resolveRectCenter } from './interaction-targeting.ts';

export type ReadElementTextAtPoint = ElementTextRuntimeOperations['readTextAtPoint'];

/**
 * When a selector read consults the owner's live point read, and what it does with the answer.
 * This module owns that policy only: the read itself is injected, so nothing here names a
 * platform. A migrated command passes its bound `readTextAtPoint` — including passing nothing
 * when its selected owner's facts report no live read, which is the complete required path.
 */
export async function readTextForNode(params: {
  device: SessionState['device'];
  node: SnapshotNode;
  flags: CommandFlags | undefined;
  appBundleId?: string;
  traceOutPath?: string;
  surface?: SessionState['surface'];
  readTextAtPoint?: ReadElementTextAtPoint;
  contextFromFlags: ContextFromFlags;
}): Promise<string> {
  const { device, node, flags, appBundleId, traceOutPath, surface, contextFromFlags } = params;
  const fallbackText = extractReadableText(node);
  const readTextAtPoint = params.readTextAtPoint;
  // No live read on this owner: the captured tree is the whole answer, with nothing to disclose.
  if (!readTextAtPoint) return fallbackText;
  const center = resolveRectCenter(node.rect);
  if (!center) {
    return fallbackText;
  }

  // iOS only: the XCUITest backend `readText` re-resolves the element at a point by enumerating
  // the full element tree (allElementsBoundByIndex), which is ~20x slower than the snapshot we
  // already captured to resolve this node. That re-read only recovers fuller text for
  // editable/expandable inputs (textField/searchField/textView/…), where the live value can
  // exceed the snapshot; for every other element type the snapshot node text is authoritative.
  // Restricted to iOS because other backends read differently — macOS helper and Linux reads
  // are value-first (AXValue/title/description), unlike the label-first snapshot readable text,
  // so skipping their backend read would change the returned text.
  if (isIosFamily(device) && fallbackText && !prefersValueForReadableText(node.type ?? '')) {
    return fallbackText;
  }

  const context = contextFromFlags(flags, appBundleId, traceOutPath);
  // No try/catch: an unexpected read failure propagates. Only the outcomes the contract
  // classifies fall back to the captured tree (ADR 0019 §2 typed reason), so a runner or
  // helper failure can never masquerade as "this element has no text".
  const outcome = await readTextAtPoint({
    point: center,
    options: { appBundleId, surface },
    execution: runtimeExecutionFromContext(context),
  });
  if (outcome.status === 'read') return outcome.text;
  emitDiagnostic({
    level: 'warn',
    phase: 'interaction_read_fallback',
    data: {
      reason: classifiedFallbackReason(outcome.reason),
      nodeRef: node.ref,
      surface,
      platform: device.platform,
    },
  });
  return fallbackText;
}

/**
 * The typed reason a fallback to the captured tree is allowed, one diagnostic reason per
 * classified outcome. The `satisfies never` arm makes a new `ElementTextUnreadableReason`
 * a COMPILE error here rather than a silent untyped fallback.
 */
function classifiedFallbackReason(reason: ElementTextUnreadableReason): string {
  switch (reason) {
    case 'no-text-at-point':
      return 'no_text_at_point';
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}
