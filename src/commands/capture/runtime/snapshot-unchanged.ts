import type { SnapshotCommandOptions } from '../../runtime-types.ts';
import {
  buildSnapshotPresentationKey,
  type Rect,
  type SnapshotNode,
  type SnapshotState,
  type SnapshotUnchanged,
} from '@agent-device/kernel/snapshot';

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
  return (
    previous.nodes.length === current.nodes.length &&
    previous.nodes.every((node, index) => areSnapshotNodesEquivalent(node, current.nodes[index]!))
  );
}

// Native text-entry/visibility facts are not rendered; refs and process ids are volatile.
// Inheritance markers are output-only: this comparison runs before label deduplication.
type ComparableSnapshotNode = Omit<
  SnapshotNode,
  | 'ref'
  | 'pid'
  | 'editable'
  | 'password'
  | 'hintShowing'
  | 'selectionStart'
  | 'selectionEnd'
  | 'visibleToUser'
  | 'inheritsLabel'
  | 'inheritsIdentifier'
>;

type ScalarPresentationField = Exclude<
  keyof ComparableSnapshotNode,
  'rect' | 'presentationHints' | 'actions'
>;

const PRESENTATION_SCALAR_FIELDS = {
  index: true,
  depth: true,
  parentIndex: true,
  type: true,
  role: true,
  subrole: true,
  label: true,
  value: true,
  identifier: true,
  enabled: true,
  selected: true,
  focused: true,
  hittable: true,
  bundleId: true,
  appName: true,
  windowTitle: true,
  surface: true,
  hiddenContentAbove: true,
  hiddenContentBelow: true,
  interactionBlocked: true,
} satisfies Record<ScalarPresentationField, true>;

const PRESENTATION_SCALAR_KEYS = Object.keys(
  PRESENTATION_SCALAR_FIELDS,
) as ScalarPresentationField[];

function areSnapshotNodesEquivalent(previous: SnapshotNode, current: SnapshotNode): boolean {
  return (
    PRESENTATION_SCALAR_KEYS.every((field) => previous[field] === current[field]) &&
    areRectsEquivalent(previous.rect, current.rect) &&
    areStringArraysEquivalent(previous.presentationHints, current.presentationHints) &&
    areStringArraysEquivalent(previous.actions, current.actions)
  );
}

function areRectsEquivalent(previous: Rect | undefined, current: Rect | undefined): boolean {
  if (!previous || !current) return previous === current;
  return (
    previous.x === current.x &&
    previous.y === current.y &&
    previous.width === current.width &&
    previous.height === current.height
  );
}

function areStringArraysEquivalent(
  previous: readonly string[] | undefined,
  current: readonly string[] | undefined,
): boolean {
  if (!previous || !current) return previous === current;
  return (
    previous.length === current.length && previous.every((value, index) => value === current[index])
  );
}
