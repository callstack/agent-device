import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  ElementTextRuntimeOperations,
  ElementTextUnreadableReason,
} from '@agent-device/contracts/element-text-runtime';
import { isIosFamily } from '@agent-device/kernel/device';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionSurface } from '@agent-device/contracts/session';
import {
  extractReadableText,
  prefersValueForReadableText,
} from '../snapshot/snapshot-presentation/text-surface.ts';
import type { BoundContextFromFlags } from './context.ts';
import { resolveRectCenter } from '@agent-device/kernel/rect-center';

export type ReadElementTextAtPoint = ElementTextRuntimeOperations['readTextAtPoint'];

export async function readTextForNode(params: {
  device: DeviceInfo;
  node: SnapshotNode;
  flags: CommandFlags | undefined;
  appBundleId?: string;
  traceOutPath?: string;
  surface?: SessionSurface;
  readTextAtPoint?: ReadElementTextAtPoint;
  contextFromFlags: BoundContextFromFlags;
}): Promise<string> {
  const { device, node, flags, appBundleId, traceOutPath, surface, contextFromFlags } = params;
  const fallbackText = extractReadableText(node);
  const readTextAtPoint = params.readTextAtPoint;
  if (!readTextAtPoint) return fallbackText;
  const center = resolveRectCenter(node.rect);
  if (!center) {
    return fallbackText;
  }

  if (isIosFamily(device) && fallbackText && !prefersValueForReadableText(node.type ?? '')) {
    return fallbackText;
  }

  const context = contextFromFlags(flags, appBundleId, traceOutPath);
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
