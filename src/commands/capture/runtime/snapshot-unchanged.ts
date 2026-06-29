import type { SnapshotCommandOptions } from '../../runtime-types.ts';
import {
  buildSnapshotPresentationKey,
  type SnapshotNode,
  type SnapshotState,
  type SnapshotUnchanged,
} from '../../../kernel/snapshot.ts';

type SnapshotIdentity = {
  previousAppBundleId?: string;
  currentAppBundleId?: string;
};

export function ensureSnapshotPresentationKey(
  snapshot: SnapshotState,
  options: SnapshotCommandOptions,
): SnapshotState {
  if (snapshot.presentationKey) return snapshot;
  return {
    ...snapshot,
    presentationKey: buildSnapshotPresentationKey(options),
  };
}

export function buildUnchangedSnapshotMetadata(params: {
  previous: SnapshotState | undefined;
  current: SnapshotState;
  options: SnapshotCommandOptions;
  identity?: SnapshotIdentity;
}): SnapshotUnchanged | undefined {
  const { previous, current, options, identity } = params;
  if (options.forceFull === true || options.raw === true) return undefined;
  if (!previous) return undefined;
  if (previous.comparisonSafe === false || current.comparisonSafe === false) return undefined;
  if (!hasSameSnapshotIdentity(previous, current, identity)) return undefined;
  if (!previous.presentationKey || previous.presentationKey !== current.presentationKey) {
    return undefined;
  }
  if (!areSnapshotPresentationsEquivalent(previous, current)) return undefined;
  const scope = options.scope?.trim();
  return {
    ageMs: Math.max(0, current.createdAt - previous.createdAt),
    nodeCount: current.nodes.length,
    ...(options.interactiveOnly === true ? { interactiveOnly: true } : {}),
    ...(scope ? { scope } : {}),
  };
}

function hasSameSnapshotIdentity(
  previous: SnapshotState,
  current: SnapshotState,
  identity: SnapshotIdentity | undefined,
): boolean {
  if (previous.backend && current.backend && previous.backend !== current.backend) {
    return false;
  }
  if (
    identity?.previousAppBundleId &&
    identity.currentAppBundleId &&
    identity.previousAppBundleId !== identity.currentAppBundleId
  ) {
    return false;
  }
  return true;
}

function areSnapshotPresentationsEquivalent(
  previous: SnapshotState,
  current: SnapshotState,
): boolean {
  if (previous.truncated !== current.truncated) return false;
  // TODO: replace stringify with a field-by-field comparison or stable presentation hash.
  return (
    JSON.stringify(buildComparableSnapshotPresentation(previous.nodes)) ===
    JSON.stringify(buildComparableSnapshotPresentation(current.nodes))
  );
}

function buildComparableSnapshotPresentation(
  nodes: readonly SnapshotNode[],
): ComparableSnapshotNode[] {
  return nodes.map((node) => ({
    index: node.index,
    depth: node.depth,
    parentIndex: node.parentIndex,
    type: node.type,
    role: node.role,
    subrole: node.subrole,
    label: node.label,
    value: node.value,
    identifier: node.identifier,
    enabled: node.enabled,
    selected: node.selected,
    focused: node.focused,
    hittable: node.hittable,
    rect: node.rect,
    bundleId: node.bundleId,
    appName: node.appName,
    windowTitle: node.windowTitle,
    surface: node.surface,
    hiddenContentAbove: node.hiddenContentAbove,
    hiddenContentBelow: node.hiddenContentBelow,
    interactionBlocked: node.interactionBlocked,
    presentationHints: node.presentationHints,
  }));
}

type ComparableSnapshotNode = Omit<SnapshotNode, 'ref' | 'pid'>;
