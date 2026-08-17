import type { RawSnapshotNode, SnapshotCaptureBackend } from '@agent-device/kernel/snapshot';
import { projectIosScrollVisibility } from '../../../snapshot/ios-scroll-visibility.ts';
import { mergeReplacement, type SnapshotTreeRuleContext } from '../tree.ts';

export function collectIosViewportPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
  captureBackend?: SnapshotCaptureBackend,
): void {
  const projection = projectIosScrollVisibility(nodes, captureBackend);
  for (const index of projection.hiddenIndexes) {
    context.suppressedIndexes.add(index);
  }
  for (const [scrollIndex, hint] of projection.hintsByScrollIndex) {
    const scroll = context.sourceNodesByIndex.get(scrollIndex);
    if (!scroll) continue;
    mergeReplacement(context.replacements, scroll, {
      ...(hint.above || scroll.hiddenContentAbove ? { hiddenContentAbove: true } : {}),
      ...(hint.below || scroll.hiddenContentBelow ? { hiddenContentBelow: true } : {}),
    });
  }
}
