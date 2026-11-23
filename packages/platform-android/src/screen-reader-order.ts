/*
 * Ported from TalkBack's OrderedTraversalController, ReorderedChildrenIterator,
 * NodeCachedBoundsCalculator, WorkingTree (Copyright (C) 2015 The Android Open Source Project) and
 * AccessibilityNodeInfoUtils.shouldFocusNode (Copyright (C) 2012 The Android Open Source Project),
 * https://github.com/google/talkback at 229212fdf5842191d0a93fc95d9ca1423b346866 (TalkBack 16.2),
 * licensed under the Apache License, Version 2.0 (LICENSES/Apache-2.0.txt).
 *
 * Changes: translated to TypeScript; reads one helper capture instead of live nodes; drops nodes
 * that are not important for accessibility, which a UiAutomation capture includes and TalkBack
 * never receives. Web content, picture-in-picture, the FAB-first option, and initial focus are
 * left out.
 */
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  ANDROID_WINDOW_TYPE_APPLICATION,
  readAndroidScreenReaderFacts,
  type AndroidNode,
  type AndroidScreenReaderFacts,
} from './ui-hierarchy-node.ts';

type Bounds = { left: number; top: number; right: number; bottom: number };

type ReaderNode = {
  source: AndroidNode;
  facts: AndroidScreenReaderFacts;
  parent?: ReaderNode;
  children: ReaderNode[];
  bounds: Bounds;
  windowBounds?: Bounds;
};

/**
 * TalkBack's swipe order estimated for each application window of a helper capture, in capture
 * window order: the source nodes a swipe lands on. Undefined when the helper predates the facts.
 */
export function estimateTalkBackOrder(tree: AndroidNode): AndroidNode[][] | undefined {
  const windows = tree.children.filter(
    (root) => root.windowType === ANDROID_WINDOW_TYPE_APPLICATION,
  );
  if (windows.length === 0 || windows.some((root) => !readAndroidScreenReaderFacts(root))) {
    return undefined;
  }
  return windows.map((root) => {
    const rules = new FocusRules();
    const window = importantTree(root);
    if (!window) return [];
    return orderedNodes(window, rules)
      .filter((node) => rules.shouldFocus(node))
      .map((node) => node.source);
  });
}

/**
 * TalkBack walks the tree the platform hands an accessibility service. A UiAutomation capture also
 * carries views that are not important for accessibility; their children take their place.
 */
function importantTree(root: AndroidNode): ReaderNode | undefined {
  const windowBounds = root.windowRect ? toBounds(root.windowRect) : undefined;
  const keep = (node: AndroidNode, parent: ReaderNode | undefined): ReaderNode[] => {
    const facts = readAndroidScreenReaderFacts(node);
    if (!facts) return [];
    if (parent !== undefined && facts.important === false) {
      return node.children.flatMap((child) => keep(child, parent));
    }
    const reader: ReaderNode = {
      source: node,
      facts,
      parent,
      children: [],
      bounds: node.rect ? toBounds(node.rect) : { left: 0, top: 0, right: 0, bottom: 0 },
      windowBounds,
    };
    reader.children = node.children.flatMap((child) => keep(child, reader));
    return [reader];
  };
  return keep(root, undefined)[0];
}

function toBounds(rect: Rect): Bounds {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
}

// AccessibilityNodeInfoUtils focus rules.

class FocusRules {
  private readonly speaking = new Map<ReaderNode, boolean>();
  // Upstream asks the same node again for every descendant; the answer depends on the tree only.
  private readonly focus = [new Map<ReaderNode, boolean>(), new Map<ReaderNode, boolean>()];

  shouldFocus(node: ReaderNode, checkChildren = true): boolean {
    const memo = this.focus[checkChildren ? 1 : 0]!;
    let result = memo.get(node);
    if (result === undefined) {
      result = this.computeShouldFocus(node, checkChildren);
      memo.set(node, result);
    }
    return result;
  }

  private computeShouldFocus(node: ReaderNode, checkChildren: boolean): boolean {
    if (!isVisible(node)) return false;
    if (
      sameBounds(node.bounds, node.windowBounds) &&
      node.children.length > 0 &&
      !isFocusableOrClickable(node)
    ) {
      return false;
    }
    const focusable =
      isFocusableOrClickable(node) ||
      (isTopLevelScrollItem(node) && this.isSpeaking(node, new Set()));
    if (!checkChildren) return focusable;
    if (focusable) {
      return node.children.length === 0 || this.isSpeaking(node, new Set(), true);
    }
    return (
      !hasMatchingAncestor(node, (ancestor) => this.shouldFocus(ancestor, false)) &&
      (hasText(node) || hasStateDescription(node))
    );
  }

  isSpeaking(node: ReaderNode, visited: Set<ReaderNode>, cached = false): boolean {
    if (cached && this.speaking.has(node)) return this.speaking.get(node)!;
    const result =
      hasText(node) ||
      hasStateDescription(node) ||
      isCheckable(node) ||
      this.hasNonActionableSpeakingChildren(node, visited, cached);
    if (cached) this.speaking.set(node, result);
    return result;
  }

  private hasNonActionableSpeakingChildren(
    node: ReaderNode,
    visited: Set<ReaderNode>,
    cached: boolean,
  ): boolean {
    for (const child of node.children) {
      if (visited.has(child)) return false;
      visited.add(child);
      if (!isVisible(child) || isFocusableOrClickable(child)) continue;
      if (
        isTopLevelScrollItem(child) &&
        this.isSpeaking(child, visited, cached) &&
        !(node.source.clickable || isLongClickable(node))
      ) {
        continue;
      }
      if (this.isSpeaking(child, visited, cached)) return true;
    }
    if (node.source.scrollable === true) return false;
    return node.children.some(
      (child) =>
        !isVisible(child) &&
        hasText(child) &&
        !(child.facts.screenReaderFocusable || isActionableForAccessibility(child)),
    );
  }
}

function isVisible(node: ReaderNode): boolean {
  return node.source.visibleToUser !== false;
}

function isLongClickable(node: ReaderNode): boolean {
  return node.source.passiveFacts.longClickable === true;
}

function isCheckable(node: ReaderNode): boolean {
  return node.source.passiveFacts.checked !== undefined;
}

/** Text, content description, or hint; a collection's own text is not read as its name. */
function hasText(node: ReaderNode): boolean {
  return (
    !node.facts.collection && Boolean(node.source.label || node.source.passiveFacts.placeholder)
  );
}

function hasStateDescription(node: ReaderNode): boolean {
  return node.facts.stateDescription || isCheckable(node) || node.facts.range;
}

function isActionableForAccessibility(node: ReaderNode): boolean {
  return (
    node.source.clickable ||
    isLongClickable(node) ||
    node.source.focusable ||
    node.facts.focusAction
  );
}

function isFocusableOrClickable(node: ReaderNode): boolean {
  return (
    isVisible(node) && (node.facts.screenReaderFocusable || isActionableForAccessibility(node))
  );
}

function isTopLevelScrollItem(node: ReaderNode): boolean {
  return isVisible(node) && node.parent !== undefined && isScrollItemContainer(node.parent);
}

const SCROLL_CONTAINER = /(ListView|GridView|RecyclerView|ScrollView|HorizontalScrollView)$/;

function isScrollItemContainer(node: ReaderNode): boolean {
  const className = node.source.type ?? '';
  if (/Spinner$/.test(className)) return false;
  return (
    node.source.scrollable === true || node.facts.collection || SCROLL_CONTAINER.test(className)
  );
}

function hasMatchingAncestor(node: ReaderNode, predicate: (ancestor: ReaderNode) => boolean) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (predicate(ancestor)) return true;
  }
  return false;
}

function sameBounds(a: Bounds, b: Bounds | undefined): boolean {
  return (
    b !== undefined &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom
  );
}

// NodeCachedBoundsCalculator.

class BoundsCalculator {
  private readonly cache = new Map<ReaderNode, Bounds | undefined>();
  private readonly calculating = new Set<ReaderNode>();
  private readonly rules: FocusRules;

  constructor(rules: FocusRules) {
    this.rules = rules;
  }

  get(node: ReaderNode): Bounds | undefined {
    if (this.calculating.has(node)) return undefined;
    if (this.cache.has(node)) return this.cache.get(node);
    this.calculating.add(node);
    const bounds = this.fetch(node);
    this.cache.set(node, bounds);
    this.calculating.delete(node);
    return bounds;
  }

  usesChildrenBounds(node: ReaderNode): boolean {
    const bounds = this.get(node);
    return bounds !== undefined && !sameBounds(node.bounds, bounds);
  }

  private fetch(node: ReaderNode): Bounds | undefined {
    if (!isVisible(node)) return undefined;
    if (this.rules.shouldFocus(node)) return nonEmpty(node.bounds);
    let child: Bounds | undefined;
    for (const candidate of node.children) {
      const bounds = this.get(candidate);
      if (!bounds) continue;
      child = child
        ? {
            left: Math.min(child.left, bounds.left),
            top: Math.min(child.top, bounds.top),
            right: Math.max(child.right, bounds.right),
            bottom: Math.max(child.bottom, bounds.bottom),
          }
        : bounds;
    }
    if (!child) return nonEmpty(node.bounds);
    return nonEmpty({
      left: Math.max(child.left, node.bounds.left),
      top: Math.max(child.top, node.bounds.top),
      right: Math.min(child.right, node.bounds.right),
      bottom: Math.min(child.bottom, node.bounds.bottom),
    });
  }
}

function nonEmpty(bounds: Bounds): Bounds | undefined {
  return bounds.left === 0 && bounds.top === 0 && bounds.right === 0 && bounds.bottom === 0
    ? undefined
    : bounds;
}

// ReorderedChildrenIterator.

function reorderedChildren(node: ReaderNode, calc: BoundsCalculator): ReaderNode[] {
  const nodes = [...node.children];
  if (nodes.length <= 1 || !nodes.some((child) => calc.usesChildrenBounds(child))) return nodes;
  for (let index = nodes.length - 2; index >= 0; index -= 1) {
    const current = nodes[index]!;
    if (!calc.usesChildrenBounds(current)) continue;
    let next = index + 1;
    while (next < nodes.length && needSwap(current, nodes[next]!, calc)) {
      nodes[next - 1] = nodes[next]!;
      nodes[next] = current;
      next += 1;
    }
  }
  return nodes;
}

function needSwap(left: ReaderNode, right: ReaderNode, calc: BoundsCalculator): boolean {
  if (compareBounds(calc.get(left), calc.get(right)) > 0) {
    return compareBounds(left.bounds, right.bounds) < 0;
  }
  return false;
}

function compareBounds(left: Bounds | undefined, right: Bounds | undefined): number {
  if (!left || !right) return -1;
  if (left.bottom - right.top <= 0) return -1;
  if (left.top - right.bottom >= 0) return 1;
  return (
    left.left - right.left ||
    left.top - right.top ||
    -(left.bottom - left.top - (right.bottom - right.top)) ||
    -(left.right - left.left - (right.right - right.left)) ||
    -1
  );
}

// WorkingTree and OrderedTraversalController.

class WorkingTree {
  parent: WorkingTree | undefined;
  readonly children: WorkingTree[] = [];
  readonly node: ReaderNode;

  constructor(node: ReaderNode, parent: WorkingTree | undefined) {
    this.node = node;
    this.parent = parent;
  }

  hasDescendant(tree: WorkingTree | undefined): boolean {
    for (let current = tree; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
}

/** Every node of the window in TalkBack's traversal order, before the focus filter. */
function orderedNodes(root: ReaderNode, rules: FocusRules): ReaderNode[] {
  const calc = new BoundsCalculator(rules);
  const trees = new Map<number, WorkingTree>();
  const build = (node: ReaderNode, parent: WorkingTree | undefined): WorkingTree | undefined => {
    if (trees.has(node.facts.axId)) return undefined;
    const tree = new WorkingTree(node, parent);
    trees.set(node.facts.axId, tree);
    for (const child of reorderedChildren(node, calc)) {
      const subtree = build(child, tree);
      if (subtree) tree.children.push(subtree);
    }
    return tree;
  };
  const top = build(root, undefined)!;

  const movedRoot = (moving: WorkingTree): WorkingTree => {
    const parent = moving.parent;
    if (parent?.node.facts.traversalBefore === undefined) return moving;
    return parent.node.facts.traversalBefore === moving.node.facts.axId
      ? movedRoot(parent)
      : moving;
  };
  const detach = (tree: WorkingTree) => {
    const siblings = tree.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(tree), 1);
    tree.parent = undefined;
  };
  const moveBefore = (moving: WorkingTree, target: WorkingTree | undefined) => {
    if (!target || moving.hasDescendant(target)) return;
    const movingRoot = movedRoot(moving);
    const parent = target.parent;
    if (movingRoot.hasDescendant(parent)) return;
    detach(movingRoot);
    if (parent) {
      const at = parent.children.indexOf(target);
      if (at >= 0) parent.children[at] = movingRoot;
    }
    movingRoot.parent = parent;
    moving.children.push(target);
    target.parent = moving;
  };
  const moveAfter = (moving: WorkingTree, target: WorkingTree | undefined) => {
    if (!target || moving.hasDescendant(target)) return;
    const movingRoot = movedRoot(moving);
    if (movingRoot.hasDescendant(target)) return;
    detach(movingRoot);
    target.children.push(movingRoot);
    movingRoot.parent = target;
  };
  for (const tree of trees.values()) {
    const { traversalBefore, traversalAfter } = tree.node.facts;
    if (traversalBefore !== undefined) moveBefore(tree, trees.get(traversalBefore));
    else if (traversalAfter !== undefined) moveAfter(tree, trees.get(traversalAfter));
  }

  let start = top;
  while (start.parent) start = start.parent;
  const order: ReaderNode[] = [];
  const walk = (tree: WorkingTree) => {
    order.push(tree.node);
    for (const child of tree.children) walk(child);
  };
  walk(start);
  return order;
}
