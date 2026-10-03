import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';
import type { AndroidNode, AndroidUiHierarchy } from './ui-hierarchy-node.ts';

const ANDROID_WINDOW_TYPE_APPLICATION = 1;

/**
 * What the regular Android projection hides before daemon publication: nodes the acquisition marks
 * invisible and stale application windows. Occlusion is deliberately absent from this boundary;
 * `buildSnapshotState` owns covered-state annotation uniformly for every Android API level.
 */
export function collectAndroidHiddenNodes(
  root: AndroidUiHierarchy,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): ReadonlySet<AndroidNode> {
  const hidden = new Set<AndroidNode>();
  collectInvisibleSubtrees(root, hidden, presentationBudget);
  collectInactiveApplicationWindows(root, hidden, presentationBudget);
  return hidden;
}

function collectInvisibleSubtrees(
  node: AndroidNode,
  hidden: Set<AndroidNode>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): void {
  for (const child of node.children) {
    presentationBudget?.check('work');
    if (child.visibleToUser === false) {
      hidden.add(child);
      continue;
    }
    collectInvisibleSubtrees(child, hidden, presentationBudget);
  }
}

/** The children of `node` this projection still shows, in document order. */
function retainedChildren(
  node: AndroidNode,
  hidden: ReadonlySet<AndroidNode>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): AndroidNode[] {
  presentationBudget?.check('work');
  return node.children.filter((child) => !hidden.has(child) && child.visibleToUser !== false);
}

function collectInactiveApplicationWindows(
  root: AndroidUiHierarchy,
  hidden: Set<AndroidNode>,
  presentationBudget?: AndroidSnapshotPresentationBudget,
): void {
  const windows = retainedChildren(root, hidden, presentationBudget).filter(isAndroidWindowRoot);
  if (windows.length < 2) return;

  // Android can keep stale application windows in the accessibility tree after drawer and
  // navigation transitions. Keep dialogs/system windows, but expose only the foreground
  // application layer so agents do not act on content that is hidden from users.
  const foregroundApplicationWindows = windows.filter(
    (window) => isAndroidApplicationWindow(window) && isAndroidForegroundWindow(window),
  );
  if (foregroundApplicationWindows.length === 0) return;
  const foregroundLayer = highestAndroidWindowLayer(foregroundApplicationWindows);

  for (const window of retainedChildren(root, hidden, presentationBudget)) {
    presentationBudget?.check('work');
    if (!isAndroidApplicationWindow(window)) continue;
    const keep =
      isAndroidForegroundWindow(window) &&
      (foregroundLayer === undefined || window.windowLayer === foregroundLayer);
    if (!keep) hidden.add(window);
  }
}

function highestAndroidWindowLayer(windows: AndroidNode[]): number | undefined {
  const layers = windows
    .map((window) => window.windowLayer)
    .filter((layer): layer is number => layer !== undefined);
  return layers.length > 0 ? Math.max(...layers) : undefined;
}

function isAndroidWindowRoot(node: AndroidNode): boolean {
  return node.windowIndex !== undefined || node.windowType !== undefined;
}

function isAndroidApplicationWindow(node: AndroidNode): boolean {
  return node.windowType === ANDROID_WINDOW_TYPE_APPLICATION;
}

function isAndroidForegroundWindow(node: AndroidNode): boolean {
  return node.windowActive === true || node.windowFocused === true;
}
