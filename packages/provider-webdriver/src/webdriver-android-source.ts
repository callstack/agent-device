import { androidSystemBarMembership } from '@agent-device/contracts/android-system-chrome';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

/** Android page-source snapshot nodes, with persistent system-bar membership per same-package subtree. */
export function parseWebDriverAndroidSnapshotNodes(source: string): RawSnapshotNode[] {
  const { nodes } = parseWebDriverSourceFacts(source, 'android');
  for (const node of nodes) {
    const parent = node.parentIndex === undefined ? undefined : nodes[node.parentIndex];
    const systemBar = androidSystemBarMembership(node.bundleId, node.identifier, parent);
    if (systemBar) node.systemBar = systemBar;
  }
  return nodes;
}
