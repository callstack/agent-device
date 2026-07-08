import { classifyAndroidInputOwnership } from '../core/android-input-ownership.ts';
import type { RawSnapshotNode, SnapshotNode, SnapshotState } from '../kernel/snapshot.ts';

const GBOARD_PACKAGE = 'com.google.android.inputmethod.latin';
const GBOARD_HANDWRITING_TITLE = 'Try out your stylus';
const GBOARD_HANDWRITING_CANCEL_ID = 'android:id/closeButton';
const GBOARD_HANDWRITING_CANCEL_LABEL = 'Cancel';

export function isAndroidInputMethodSnapshotNode(
  node: Pick<RawSnapshotNode, 'bundleId' | 'identifier'> | undefined,
): boolean {
  if (!node) return false;
  return classifyAndroidInputOwnership({
    packageName: node.bundleId,
    resourceId: node.identifier,
  }).inputMethodOwned;
}

export function findAndroidGboardHandwritingTutorialCancel(
  snapshot: SnapshotState,
): SnapshotNode | undefined {
  if (!snapshot.nodes.some(isAndroidGboardHandwritingTutorialTitle)) return undefined;
  return snapshot.nodes.find(isAndroidGboardHandwritingTutorialCancel);
}

export function hasAndroidGboardHandwritingTutorial(snapshot: SnapshotState): boolean {
  return snapshot.nodes.some(isAndroidGboardHandwritingTutorialTitle);
}

function isAndroidGboardHandwritingTutorialTitle(node: SnapshotNode): boolean {
  return isGboardSnapshotNode(node) && nodeTextValues(node).includes(GBOARD_HANDWRITING_TITLE);
}

function isAndroidGboardHandwritingTutorialCancel(node: SnapshotNode): boolean {
  if (!isGboardSnapshotNode(node)) return false;
  if (node.identifier === GBOARD_HANDWRITING_CANCEL_ID) return true;
  return nodeTextValues(node).includes(GBOARD_HANDWRITING_CANCEL_LABEL);
}

function isGboardSnapshotNode(node: SnapshotNode): boolean {
  return node.bundleId === GBOARD_PACKAGE && isAndroidInputMethodSnapshotNode(node);
}

function nodeTextValues(node: SnapshotNode): string[] {
  return [node.label, node.value].filter((value): value is string => Boolean(value));
}
