import { isPositiveFiniteRect, rectContains } from '@agent-device/kernel/rect';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';
import { isAgentTarget, type AndroidNode, type AndroidUiHierarchy } from './ui-hierarchy-node.ts';

// Compose's `SemanticsNode.emitFakeNodes` gives a merging node that has a role and children an
// extra childless child, which alone carries the role's legacy class name. That child takes no
// touch and lies inside its parent, which stays a generic `android.view.View`. A native
// `android.view.View` is not a `ViewGroup`, so only a virtual hierarchy gives one children.
const COMPOSE_ROLE_CLASS_NAMES = new Set([
  'android.widget.button',
  'android.widget.checkbox',
  'android.widget.radiobutton',
  'android.widget.spinner',
  'android.widget.numberpicker',
]);
const COMPOSE_CONTAINER_CLASS_NAME = 'android.view.view';

/** Each Compose container the regular projection publishes with its role node's class. */
export function collectComposeRoleFolds(
  root: AndroidUiHierarchy,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): ReadonlyMap<AndroidNode, AndroidNode> {
  const folds = new Map<AndroidNode, AndroidNode>();
  const visit = (node: AndroidNode): void => {
    presentationBudget?.check('work');
    const roleNode = composeRoleNodeOf(node);
    if (roleNode) folds.set(node, roleNode);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return folds;
}

function composeRoleNodeOf(node: AndroidNode): AndroidNode | undefined {
  if (!isAgentTarget(node) || node.type?.toLowerCase() !== COMPOSE_CONTAINER_CLASS_NAME) {
    return undefined;
  }
  return node.children.find((child) => isComposeRoleNode(child, node));
}

function isComposeRoleNode(child: AndroidNode, parent: AndroidNode): boolean {
  return (
    COMPOSE_ROLE_CLASS_NAMES.has(child.type?.toLowerCase() ?? '') &&
    child.children.length === 0 &&
    child.visibleToUser !== false &&
    !isAgentTarget(child) &&
    !child.label &&
    !child.identifier &&
    liesInside(child.rect, parent.rect)
  );
}

function liesInside(inner: Rect | undefined, outer: Rect | undefined): boolean {
  return isPositiveFiniteRect(inner) && outer !== undefined && rectContains(outer, inner);
}
