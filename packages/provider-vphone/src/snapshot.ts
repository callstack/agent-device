import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import { interpretIosNode } from '@agent-device/capture-kit/ios-node-interpretation';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { VPHONE_ERROR_REASONS } from './reasons.ts';
import type { VphoneTransport } from './transport.ts';

export type VphoneTreeNode = Readonly<Record<string, unknown>>;

export async function captureVphoneSnapshot(
  transport: VphoneTransport,
  machine: string,
  targetId: string,
  signal?: AbortSignal,
): Promise<SnapshotRuntimeAcquiredResult> {
  const before = readForegroundIdentity(
    await transport.rpc(machine, 'apps.foreground', {}, { signal }),
  );
  const tree = await transport.rpc(
    machine,
    'ui.tree',
    { max_elements: 2000, nested: false, visible_only: false },
    { signal },
  );
  const after = readForegroundIdentity(
    await transport.rpc(machine, 'apps.foreground', {}, { signal }),
  );
  if (before.bundleId !== after.bundleId || before.pid !== after.pid) {
    throw new AppError('COMMAND_FAILED', 'vphone foreground app changed during tree capture.', {
      reason: VPHONE_ERROR_REASONS.foregroundChanged,
      before,
      after,
    });
  }
  const elements = vphoneTreeElements(tree);
  assertVphoneTreePid(elements, before.pid);
  const screen = await transport.rpc(machine, 'device.screen', {}, { signal });
  const nodes = elements.map((node, index) =>
    interpretIosNode(mapVphoneNode(node, index, before.bundleId)),
  );
  return createIosSnapshotAcquisition({
    producer: 'vphone-ios-tree',
    nodes,
    viewport: { kind: 'reported', rect: readVphoneScreen(screen) },
    lineage: { targetId },
  });
}

export function vphoneTreeElements(tree: unknown): readonly VphoneTreeNode[] {
  if (!isRecord(tree) || !Array.isArray(tree.elements)) {
    throw new AppError('COMMAND_FAILED', 'vphone ui.tree returned no flat elements array.', {
      reason: VPHONE_ERROR_REASONS.invalidResponse,
    });
  }
  return tree.elements.filter(isRecord);
}

export function mapVphoneNode(
  node: VphoneTreeNode,
  index: number,
  bundleId?: string,
): RawSnapshotNode {
  return {
    index,
    type: stringValue(node.type) ?? stringValue(node.role),
    role: stringValue(node.role) ?? stringValue(node.type),
    label: scalarText(node.label) ?? scalarText(node.text) ?? scalarText(node.name),
    value: scalarText(node.value),
    identifier: scalarText(node.identifier),
    rect: readFrame(node.frame ?? node.rect),
    visibleToUser: readVisibility(node.visible),
    enabled: typeof node.enabled === 'boolean' ? node.enabled : undefined,
    ...(node.selected === true ? { selected: true } : {}),
    ...(node.focused === true ? { focused: true } : {}),
    bundleId,
    ...(typeof node.pid === 'number' && Number.isInteger(node.pid) ? { pid: node.pid } : {}),
  };
}

export function readVphoneScreen(value: unknown): Rect {
  const screen = isRecord(value) && isRecord(value.screen) ? value.screen : value;
  if (!isRecord(screen)) throw invalidScreen();
  const width = finiteNumber(screen.width ?? screen.point_width ?? screen.pointWidth);
  const height = finiteNumber(screen.height ?? screen.point_height ?? screen.pointHeight);
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw invalidScreen();
  }
  return { x: 0, y: 0, width, height };
}

export function vphoneElementCenter(node: VphoneTreeNode): { x: number; y: number } | undefined {
  const frame = readFrame(node.frame ?? node.rect);
  if (!frame || frame.width <= 0 || frame.height <= 0) return undefined;
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

function assertVphoneTreePid(elements: readonly VphoneTreeNode[], expectedPid: number): void {
  if (elements.every((node) => node.pid === undefined)) return;
  if (
    elements.some(
      (node) => typeof node.pid !== 'number' || !Number.isInteger(node.pid) || node.pid <= 1,
    )
  ) {
    throw new AppError('COMMAND_FAILED', 'vphone tree PID evidence is incomplete.', {
      reason: VPHONE_ERROR_REASONS.treePidUnverified,
    });
  }
  if (elements.some((node) => node.pid !== expectedPid)) {
    throw new AppError('COMMAND_FAILED', 'vphone tree and foreground PIDs do not match.', {
      reason: VPHONE_ERROR_REASONS.treePidMismatch,
      expectedPid,
      nodePids: [...new Set(elements.map((node) => node.pid))],
    });
  }
}

function readForegroundIdentity(value: unknown): Readonly<{ bundleId: string; pid: number }> {
  if (
    isRecord(value) &&
    value.verified === true &&
    typeof value.bundle_id === 'string' &&
    value.bundle_id.length > 0 &&
    typeof value.pid === 'number' &&
    Number.isInteger(value.pid) &&
    value.pid > 1
  ) {
    return { bundleId: value.bundle_id, pid: value.pid };
  }
  throw new AppError('COMMAND_FAILED', 'vphone foreground app identity is not verified.', {
    reason: VPHONE_ERROR_REASONS.foregroundUnverified,
  });
}

function readFrame(value: unknown): Rect | undefined {
  const values = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value.x, value.y, value.width, value.height]
      : [];
  const [x, y, width, height] = values.map(finiteNumber);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function readVisibility(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function invalidScreen(): AppError {
  return new AppError('COMMAND_FAILED', 'vphone device.screen returned invalid point dimensions.', {
    reason: VPHONE_ERROR_REASONS.invalidResponse,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
