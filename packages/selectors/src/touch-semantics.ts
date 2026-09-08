import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';

const TOUCH_ROLE_FRAGMENTS = [
  'button',
  'link',
  'menuitem',
  'tabitem',
  'textfield',
  'searchfield',
  'securetextfield',
  'checkbox',
  'radio',
  'switch',
  'cell',
];

export function isSemanticTouchTarget(node: SnapshotNode): boolean {
  const roles = [node.type, node.role, node.subrole].map((value) => normalizeType(value ?? ''));
  return roles.some(
    (role) => role === 'tab' || TOUCH_ROLE_FRAGMENTS.some((fragment) => role.includes(fragment)),
  );
}
