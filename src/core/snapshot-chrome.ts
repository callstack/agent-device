import type { SnapshotNode } from '../kernel/snapshot.ts';
import { isAndroidInputMethodSnapshotNode } from '../snapshot/android-input-method-overlays.ts';
import { normalizeType } from '../utils/text-surface.ts';

/**
 * Structural keyboard / IME / persistent-system chrome classifier over a
 * captured `SnapshotNode[]`. Lives in `core/` (below both `commands/` and
 * `daemon/`) so every ref-selection budget — `--settle`'s content-first diff
 * and unchanged-interactive tail (#1101/#1167/#1198/#1200) AND the replay
 * divergence `screen.refs` cap (ADR 0012 decision 6) — reuses the SAME
 * classification instead of duplicating a keyboard/IME node-type list.
 *
 * Detection is deliberately structural (element type + `parentIndex` chains +
 * Android `bundleId`/resource-id markers), never label-based: keyboard chrome
 * text is locale-dependent.
 */

// Editable text roles (normalized `node.type` vocabulary) used by the
// keyboard-window guard below.
const EDITABLE_TEXT_TYPES = new Set([
  'textfield',
  'securetextfield',
  'textview',
  'textarea',
  'searchfield',
  'edittext',
]);

/**
 * Keyboard chrome classification, live-verified against the iPhone 17 Pro
 * simulator (iOS 26, July 2026): the software keyboard renders in its OWN
 * dedicated window (UIRemoteKeyboardWindow). That window contains the
 * `[Keyboard]` container (keys plus real XCUIElementTypeButton chrome like
 * shift/Emoji/return) AND a SIBLING subtree holding the "Next keyboard" and
 * "Dictate" buttons — siblings of the container, so a container-descendant
 * walk alone provably misses them. The rule is therefore: every node inside
 * a window that has a `[Keyboard]` descendant is keyboard chrome.
 *
 * Detection stays structural (`parentIndex` chains), never label-based:
 * keyboard chrome text is locale-dependent (the verified capture had Polish
 * key labels) and a label list would silently stop matching under a
 * different input language.
 *
 * Conservative guard: a window that also hosts an editable text node OUTSIDE
 * the keyboard container is never window-classified — iOS hosts
 * inputAccessoryView content (e.g. a messaging composer) in the keyboard
 * window, and hiding the field the user is typing into would be worse than
 * leaking chrome. Such windows fall back to the container-descendant walk.
 *
 * App-owned accessory guard: even when whole-window classification IS applied
 * (a button-only accessory has no editable text to trip the guard above), an
 * `inputAccessoryView` / formatting / send toolbar the app hosts in the
 * keyboard window is a legitimate control the agent must still see. All of the
 * keyboard's OWN chrome — keys, shift/Emoji/return, and the "Next keyboard" /
 * "Dictate" assistant buttons — renders within the keyboard container's own
 * frame (bottom of the screen), while an inputAccessoryView renders as a bar
 * ABOVE the keys. So any non-keyboard node in the keyboard window whose center
 * sits above the keyboard container's top edge is app-owned and survives
 * classification (`collectKeyboardAccessoryIndexes`). Structural spine nodes
 * (the window and wrappers that CONTAIN the keyboard) are never exempted, so a
 * genuine key-only keyboard window is classified exactly as before.
 */
type SettleChrome = {
  /** Chrome node indexes EXCLUDING the containers: stripped from the diff. */
  strippedIndexes: ReadonlySet<number>;
  /** Refs of ALL chrome incl. containers/window: trigger + tail exclusion. */
  refs: ReadonlySet<string>;
};

const EMPTY_SETTLE_CHROME: SettleChrome = { strippedIndexes: new Set(), refs: new Set() };

function collectKeyboardChrome(nodes: SnapshotNode[]): SettleChrome {
  const containerIndexes = new Set(
    nodes.filter((node) => normalizeType(node.type ?? '') === 'keyboard').map((node) => node.index),
  );
  if (containerIndexes.size === 0) return EMPTY_SETTLE_CHROME;
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const containerSubtreeIndexes = collectSubtreeIndexes(nodes, byIndex, containerIndexes);
  const chromeIndexes = new Set(containerSubtreeIndexes);
  const windowIndexes = resolveKeyboardWindowIndexes(nodes, byIndex, containerSubtreeIndexes);
  for (const index of collectSubtreeIndexes(nodes, byIndex, windowIndexes)) {
    chromeIndexes.add(index);
  }
  // Preserve app-owned accessory controls hosted above the keyboard: they were
  // swept in by the whole-window pass but are not keyboard chrome.
  for (const index of collectKeyboardAccessoryIndexes(
    nodes,
    byIndex,
    windowIndexes,
    containerIndexes,
    containerSubtreeIndexes,
  )) {
    chromeIndexes.delete(index);
  }
  const refs = new Set(
    nodes.filter((node) => node.ref && chromeIndexes.has(node.index)).map((node) => node.ref),
  );
  // The [Keyboard] container line itself survives the diff so "keyboard
  // appeared/left" stays one visible signal line; everything else collapses.
  const strippedIndexes = new Set(
    [...chromeIndexes].filter((index) => !containerIndexes.has(index)),
  );
  return { strippedIndexes, refs };
}

/**
 * Indexes of app-owned accessory content in a keyboard window: non-keyboard
 * nodes whose center sits ABOVE the keyboard container's top edge (an
 * `inputAccessoryView` toolbar renders above the keys). Structural spine nodes
 * that CONTAIN the keyboard (the window and its wrappers) are excluded — their
 * frames span the keys, and exempting them would leak the keyboard itself.
 */
function collectKeyboardAccessoryIndexes(
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
  windowIndexes: ReadonlySet<number>,
  containerIndexes: ReadonlySet<number>,
  containerSubtreeIndexes: ReadonlySet<number>,
): Set<number> {
  const exempt = new Set<number>();
  if (windowIndexes.size === 0) return exempt;
  const keyboardTopByWindow = collectKeyboardTopByWindow(byIndex, windowIndexes, containerIndexes);
  if (keyboardTopByWindow.size === 0) return exempt;
  const spineIndexes = collectContainerAncestorIndexes(byIndex, containerIndexes);
  for (const node of nodes) {
    const eligible =
      !containerSubtreeIndexes.has(node.index) && !spineIndexes.has(node.index) && node.rect;
    if (eligible && isAboveKeyboard(node, byIndex, keyboardTopByWindow)) exempt.add(node.index);
  }
  return exempt;
}

/** True when the node renders above its keyboard window's key area (an accessory bar). */
function isAboveKeyboard(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
  keyboardTopByWindow: ReadonlyMap<number, number>,
): boolean {
  if (!node.rect) return false;
  const window = findNearestWindowAncestor(node, byIndex);
  if (window === undefined) return false;
  const keyboardTop = keyboardTopByWindow.get(window);
  return keyboardTop !== undefined && node.rect.y + node.rect.height / 2 < keyboardTop;
}

/** Per keyboard window, the top edge (min `rect.y`) of its keyboard container(s). */
function collectKeyboardTopByWindow(
  byIndex: Map<number, SnapshotNode>,
  windowIndexes: ReadonlySet<number>,
  containerIndexes: ReadonlySet<number>,
): Map<number, number> {
  const keyboardTopByWindow = new Map<number, number>();
  for (const containerIndex of containerIndexes) {
    const container = byIndex.get(containerIndex);
    if (!container?.rect) continue;
    const window = findNearestWindowAncestor(container, byIndex);
    if (window === undefined || !windowIndexes.has(window)) continue;
    const currentTop = keyboardTopByWindow.get(window);
    if (currentTop === undefined || container.rect.y < currentTop) {
      keyboardTopByWindow.set(window, container.rect.y);
    }
  }
  return keyboardTopByWindow;
}

/** Every ancestor of every keyboard container (the structural spine that hosts it). */
function collectContainerAncestorIndexes(
  byIndex: Map<number, SnapshotNode>,
  containerIndexes: ReadonlySet<number>,
): Set<number> {
  const ancestors = new Set<number>();
  for (const containerIndex of containerIndexes) {
    const container = byIndex.get(containerIndex);
    let current =
      container && typeof container.parentIndex === 'number'
        ? byIndex.get(container.parentIndex)
        : undefined;
    while (current) {
      ancestors.add(current.index);
      current =
        typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
    }
  }
  return ancestors;
}

/** The root indexes plus every node whose parent chain passes through one. */
function collectSubtreeIndexes(
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
  rootIndexes: ReadonlySet<number>,
): Set<number> {
  const indexes = new Set(rootIndexes);
  if (rootIndexes.size === 0) return indexes;
  for (const node of nodes) {
    if (hasAncestorIn(node, byIndex, rootIndexes)) indexes.add(node.index);
  }
  return indexes;
}

// SystemUI hosts BOTH persistent chrome and actionable overlays (volume
// panel, media/output pickers), so chrome is never a package-level fact.
// Within `com.android.systemui`, only window-runs carrying a status-bar or
// navigation-bar marker resource-id drop; every other systemui surface is
// kept. Marker set live-verified on the emulator: the status-bar window
// carries `status_bar*` ids throughout while the VolumeDialog window carries
// only `volume_dialog*` ids (`input_method_nav*` bars are IME-owned and
// handled by the IME tier).
const ANDROID_SYSTEM_CHROME_PACKAGE = 'com.android.systemui';
const ANDROID_SYSTEM_CHROME_MARKER_PREFIXES = [
  'com.android.systemui:id/status_bar',
  'com.android.systemui:id/navigation_bar',
];

function hasAndroidSystemChromeMarker(node: SnapshotNode): boolean {
  const identifier = node.identifier ?? '';
  return ANDROID_SYSTEM_CHROME_MARKER_PREFIXES.some((prefix) => identifier.startsWith(prefix));
}

/**
 * Android settle chrome (#1198): IME-owned nodes collapse to one surviving
 * line per contiguous run; systemui status/nav-bar window-runs drop from both
 * diff sides; every other foreign node — system dialogs (package `android`),
 * permission prompts, AND actionable systemui overlays like the volume panel
 * — is kept in full. Constraint: package membership is strictly per-node by
 * the node's own `bundleId` — parentIndex chains can cross windows on Android
 * (enforced by the settle.test.ts cross-window regression test); run grouping
 * only ever walks parent chains BETWEEN same-package nodes, so it cannot
 * swallow another package's node. Inert on iOS/macOS: those nodes never set
 * `bundleId`.
 */
function collectAndroidSettleChrome(
  nodes: SnapshotNode[],
  appBundleId: string | undefined,
): SettleChrome {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const imeIndexes = new Set(
    nodes.filter((node) => isAndroidInputMethodSnapshotNode(node)).map((node) => node.index),
  );
  const imeContainerIndexes = new Set(
    [...imeIndexes].filter((index) => {
      const parentIndex = byIndex.get(index)?.parentIndex;
      const parent = parentIndex !== undefined ? byIndex.get(parentIndex) : undefined;
      return !parent || !imeIndexes.has(parent.index);
    }),
  );
  // appBundleId is the session's pre-action value (not refreshed inside the
  // settle loop); it is only a never-drop-the-app-under-test guard here, so
  // staleness cannot hide a foreign dialog.
  const systemChromeIndexes =
    appBundleId === ANDROID_SYSTEM_CHROME_PACKAGE
      ? new Set<number>()
      : collectAndroidSystemChromeRunIndexes(nodes, byIndex, imeIndexes);
  // The one surviving container line per IME run; the rest of the run and all
  // status/nav-bar chrome never spend diff/tail budget.
  const strippedIndexes = new Set(
    [...imeIndexes].filter((index) => !imeContainerIndexes.has(index)),
  );
  for (const index of systemChromeIndexes) strippedIndexes.add(index);
  const refs = new Set(
    nodes
      .filter(
        (node) => node.ref && (imeIndexes.has(node.index) || systemChromeIndexes.has(node.index)),
      )
      .map((node) => node.ref),
  );
  if (strippedIndexes.size === 0 && refs.size === 0) return EMPTY_SETTLE_CHROME;
  return { strippedIndexes, refs };
}

/**
 * Systemui window-runs (contiguous same-package parent chains) that contain a
 * status/nav-bar marker anywhere in the run. The whole marked run drops —
 * unmarked wrappers above `status_bar_container` churn with the bar itself —
 * while unmarked runs (volume panel, media pickers) are kept whole.
 */
function collectAndroidSystemChromeRunIndexes(
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
  imeIndexes: ReadonlySet<number>,
): Set<number> {
  const systemUiIndexes = new Set(
    nodes
      .filter(
        (node) => node.bundleId === ANDROID_SYSTEM_CHROME_PACKAGE && !imeIndexes.has(node.index),
      )
      .map((node) => node.index),
  );
  if (systemUiIndexes.size === 0) return new Set();
  // Union-find-lite: each systemui node resolves to its run root (the nearest
  // ancestor chain member whose parent is absent or not systemui).
  const runRootByIndex = new Map<number, number>();
  const resolveRunRoot = (index: number): number => {
    const cached = runRootByIndex.get(index);
    if (cached !== undefined) return cached;
    const parentIndex = byIndex.get(index)?.parentIndex;
    const root =
      parentIndex !== undefined && systemUiIndexes.has(parentIndex)
        ? resolveRunRoot(parentIndex)
        : index;
    runRootByIndex.set(index, root);
    return root;
  };
  const markedRunRoots = new Set(
    [...systemUiIndexes]
      .filter((index) => {
        const node = byIndex.get(index);
        return node !== undefined && hasAndroidSystemChromeMarker(node);
      })
      .map((index) => resolveRunRoot(index)),
  );
  return new Set([...systemUiIndexes].filter((index) => markedRunRoots.has(resolveRunRoot(index))));
}

/** iOS keyboard-window chrome unioned with Android IME/system chrome. */
function collectSettleChrome(nodes: SnapshotNode[], appBundleId: string | undefined): SettleChrome {
  const keyboard = collectKeyboardChrome(nodes);
  const android = collectAndroidSettleChrome(nodes, appBundleId);
  if (keyboard.strippedIndexes.size === 0 && keyboard.refs.size === 0) return android;
  if (android.strippedIndexes.size === 0 && android.refs.size === 0) return keyboard;
  return {
    strippedIndexes: new Set([...keyboard.strippedIndexes, ...android.strippedIndexes]),
    refs: new Set([...keyboard.refs, ...android.refs]),
  };
}

export function withoutSettleChrome(
  nodes: SnapshotNode[],
  appBundleId: string | undefined,
): SnapshotNode[] {
  const { strippedIndexes } = collectSettleChrome(nodes, appBundleId);
  if (strippedIndexes.size === 0) return nodes;
  return nodes.filter((node) => !strippedIndexes.has(node.index));
}

/**
 * Refs of iOS keyboard-window chrome unioned with Android IME/system chrome
 * (see `collectSettleChrome`). Used by any ref-selection budget — the settle
 * tail AND the replay divergence `screen.refs` cap (ADR 0012 decision 6) — to
 * exclude keyboard/IME chrome without duplicating the structural classification.
 */
export function collectSettleChromeRefs(
  nodes: SnapshotNode[],
  appBundleId: string | undefined,
): ReadonlySet<string> {
  return collectSettleChrome(nodes, appBundleId).refs;
}

/**
 * Windows eligible for whole-window chrome classification: nearest `[window]`
 * ancestor of each `[Keyboard]` container, minus windows hosting editable
 * text outside the container subtree (the inputAccessoryView guard above).
 */
function resolveKeyboardWindowIndexes(
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
  containerChromeIndexes: ReadonlySet<number>,
): Set<number> {
  const windowIndexes = new Set<number>();
  for (const index of containerChromeIndexes) {
    const node = byIndex.get(index);
    if (!node || normalizeType(node.type ?? '') !== 'keyboard') continue;
    const windowAncestor = findNearestWindowAncestor(node, byIndex);
    if (windowAncestor !== undefined) windowIndexes.add(windowAncestor);
  }
  for (const windowIndex of windowIndexes) {
    const windowSet = new Set([windowIndex]);
    const hostsEditableText = nodes.some(
      (node) =>
        EDITABLE_TEXT_TYPES.has(normalizeType(node.type ?? '')) &&
        !containerChromeIndexes.has(node.index) &&
        hasAncestorIn(node, byIndex, windowSet),
    );
    if (hostsEditableText) windowIndexes.delete(windowIndex);
  }
  return windowIndexes;
}

function findNearestWindowAncestor(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
): number | undefined {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  while (current) {
    if (normalizeType(current.type ?? '') === 'window') return current.index;
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return undefined;
}

function hasAncestorIn(
  node: SnapshotNode,
  byIndex: Map<number, SnapshotNode>,
  ancestorIndexes: ReadonlySet<number>,
): boolean {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  while (current) {
    if (ancestorIndexes.has(current.index)) return true;
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return false;
}
