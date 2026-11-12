import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { matchesSnapshotScope } from '@agent-device/contracts/snapshot';
import { isNodeEditable } from './node.ts';

/**
 * The `wait text` match rule: the snapshot scope rule minus typed content. An editable node's
 * value is what the user typed, and Android also reports that text as the node's label, so an
 * editable node matches only by its identifier or by a label that is not its value. A value equal
 * to the placeholder is the field's hint, not typed text. The Swift runner's native `findText` is
 * pinned to the same table, `contracts/fixtures/wait-text-policy.json`.
 */
export function matchesWaitText(
  node: SnapshotNode,
  text: string,
  platform: Platform | PublicPlatform,
): boolean {
  if (!isNodeEditable(node, platform) || node.value === node.placeholder) {
    return matchesSnapshotScope(node, text);
  }
  const label = node.label === node.value ? undefined : node.label;
  return matchesSnapshotScope({ identifier: node.identifier, label }, text);
}
