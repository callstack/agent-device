import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export function node(
  index: number,
  type: string,
  overrides: Partial<RawSnapshotNode> = {},
): RawSnapshotNode {
  return {
    index,
    parentIndex: index === 0 ? undefined : 0,
    type,
    bundleId: 'com.example.app',
    ...overrides,
  };
}

export function text(
  index: number,
  label: string,
  identifier: string,
  parentIndex = 0,
): RawSnapshotNode {
  return node(index, 'android.widget.TextView', { label, identifier, parentIndex });
}

export function button(
  index: number,
  label: string,
  identifier: string,
  origin: { x: number; y: number },
  permission = false,
  parentIndex = 0,
): RawSnapshotNode {
  const packageName = permission ? 'com.google.android.permissioncontroller' : 'com.example.app';
  const id = permission ? `com.android.permissioncontroller:id/${identifier}` : identifier;
  return node(index, 'android.widget.Button', {
    label,
    identifier: id,
    bundleId: packageName,
    parentIndex,
    rect: { ...origin, width: 128, height: 52 },
    hittable: true,
  });
}
