import { isIosFamily } from '../../kernel/device.ts';
import { dispatchCommand, type CommandFlags } from '../../core/dispatch.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { extractNodeReadText } from '../../snapshot/snapshot-processing.ts';
import type { SessionState } from '../types.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';
import { prefersValueForReadableText } from '../../utils/text-surface.ts';
import type { ContextFromFlags } from './interaction-common.ts';
import { resolveRectCenter } from './interaction-targeting.ts';

export async function readTextForNode(params: {
  device: SessionState['device'];
  node: SnapshotNode;
  flags: CommandFlags | undefined;
  appBundleId?: string;
  traceOutPath?: string;
  surface?: SessionState['surface'];
  contextFromFlags: ContextFromFlags;
}): Promise<string> {
  const { device, node, flags, appBundleId, traceOutPath, surface, contextFromFlags } = params;
  const fallbackText = extractNodeReadText(node);
  const center = resolveRectCenter(node.rect);
  if (!center) {
    return fallbackText;
  }

  // iOS only: the XCUITest backend `read` re-resolves the element at a point by enumerating
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

  try {
    const rawData = await dispatchCommand(
      device,
      'read',
      [String(center.x), String(center.y)],
      undefined,
      {
        ...contextFromFlags(flags, appBundleId, traceOutPath),
        surface,
      },
    );
    const data = rawData && typeof rawData === 'object' ? rawData : undefined;
    const text = typeof data?.text === 'string' ? data.text : '';
    if (text.trim()) {
      return text;
    }
    emitDiagnostic({
      level: 'warn',
      phase: 'interaction_read_fallback',
      data: {
        reason: 'empty_backend_text',
        nodeRef: node.ref,
        surface,
        platform: device.platform,
      },
    });
    return fallbackText;
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'interaction_read_fallback',
      data: {
        reason: 'backend_read_failed',
        nodeRef: node.ref,
        surface,
        platform: device.platform,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return fallbackText;
  }
}
