import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';

/** Normalized `type`/`role`/`subrole` fragments naming persistent viewport chrome. */
export const VIEWPORT_CHROME_KIND_FRAGMENTS = ['tabbar', 'toolbar', 'navigationbar'];

/**
 * Whether a node is published as persistent viewport chrome rather than floating overlay chrome
 * (`dialog`/`sheet`/`alert` stay out). Both occlusion exemptions key on this one classification: a
 * container sized to the viewport and one sized to a sibling are the same host-not-surface verdict
 * reached against different references, so they must agree on what counts as chrome.
 *
 * Kind is read from the joined normalized fields, never a single field: the Apple AX bridge names the
 * UIKit class in `role`, while the runner path publishes only `type: 'Toolbar'`.
 */
export function isViewportChromeNode(
  node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>,
): boolean {
  const kind = [node.type, node.role, node.subrole]
    .map((value) => normalizeType(value ?? ''))
    .join(' ');
  return VIEWPORT_CHROME_KIND_FRAGMENTS.some((fragment) => kind.includes(fragment));
}
