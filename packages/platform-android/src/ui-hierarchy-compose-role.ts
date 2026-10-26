import { intersectArea } from '@agent-device/kernel/screenshot-geometry';
import type { Rect } from '@agent-device/kernel/snapshot';
import { isAgentTarget, type AndroidNode } from './ui-hierarchy-node.ts';

// Compose's `SemanticsNode.emitFakeNodes` gives a merging node that has a role and children an
// extra childless child, which alone carries the role's legacy class name. That child takes no
// touch and covers its parent, which stays a generic `android.view.View`.
const COMPOSE_ROLE_CLASS_NAMES = new Set([
  'android.widget.button',
  'android.widget.checkbox',
  'android.widget.radiobutton',
  'android.widget.spinner',
  'android.widget.numberpicker',
]);
const COMPOSE_CONTAINER_CLASS_NAME = 'android.view.view';
const MIN_ROLE_NODE_COVERAGE = 0.9;

export function composeRoleNodeOf(node: AndroidNode): AndroidNode | undefined {
  if (!isAgentTarget(node) || node.type?.toLowerCase() !== COMPOSE_CONTAINER_CLASS_NAME) {
    return undefined;
  }
  return node.children.find((child) => isComposeRoleNode(child, node));
}

function isComposeRoleNode(child: AndroidNode, parent: AndroidNode): boolean {
  return (
    COMPOSE_ROLE_CLASS_NAMES.has(child.type?.toLowerCase() ?? '') &&
    child.children.length === 0 &&
    !isAgentTarget(child) &&
    !child.label &&
    !child.identifier &&
    coverage(child.rect, parent.rect) >= MIN_ROLE_NODE_COVERAGE
  );
}

function coverage(inner: Rect | undefined, outer: Rect | undefined): number {
  if (!inner || !outer || outer.width <= 0 || outer.height <= 0) return 0;
  return intersectArea(inner, outer) / (outer.width * outer.height);
}
