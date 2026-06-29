import type { SnapshotNode } from '../../kernel/snapshot.ts';
import { areSameVisualRow, hasRenderableArea, isRectContainedBy } from './geometry.ts';
import { normalizeStructuralNodeLabel, visibleNodeLabel } from './labels.ts';
import { isEditableNode, isRootNode } from './predicates.ts';
import { collectDescendants, markNodeAndDescendantsForRemoval } from './tree.ts';

const ACTIONABLE_STRUCTURAL_TYPE_TOKENS = ['button', 'switch', 'checkbox', 'radio'];
const STRUCTURAL_NOISE_TYPE_TOKENS = ['button', 'image', 'textview', 'view'];

export function markUnlabeledActionRowsForPromotion(
  nodes: SnapshotNode[],
  removed: Set<number>,
  replacements: Map<number, SnapshotNode>,
): void {
  for (const node of nodes) {
    if (removed.has(node.index) || !isUnlabeledActionRow(node)) continue;

    const descendants = collectDescendants(nodes, node.index);
    const promotedContent = collectPromotableRowContent(descendants, node, removed);
    if (!promotedContent.label) continue;

    replacements.set(node.index, {
      ...node,
      ...replacements.get(node.index),
      label: promotedContent.label,
    });
    for (const descendantIndex of promotedContent.removableIndexes) {
      markNodeAndDescendantsForRemoval(nodes, descendantIndex, removed);
    }
  }
}

export function markAdjacentDuplicateStructuralNodesForRemoval(
  nodes: SnapshotNode[],
  removed: Set<number>,
  replacements: Map<number, SnapshotNode>,
): void {
  const lastByLabel = new Map<string, SnapshotNode>();
  for (const node of nodes) {
    if (removed.has(node.index) || !isStructuralNoiseCandidate(node)) {
      continue;
    }
    const label = normalizeStructuralNodeLabel(visibleNodeLabel(node));
    if (!label) continue;

    // RN can expose the same visible row content through parallel typed siblings
    // such as ImageView + Button or TextView + Button, so label is the signature.
    const previous = lastByLabel.get(label);
    if (previous && shouldCollapseAdjacentStructuralDuplicate(previous, node, removed)) {
      const survivor = collapseAdjacentStructuralDuplicate(
        nodes,
        previous,
        node,
        removed,
        replacements,
      );
      lastByLabel.set(label, survivor);
      continue;
    }
    lastByLabel.set(label, node);
  }
}

export function markRepeatedActionRowDescendantsForRemoval(
  nodes: SnapshotNode[],
  removed: Set<number>,
): void {
  for (const node of nodes) {
    if (removed.has(node.index) || !isActionRowParent(node)) continue;

    const parentLabel = normalizeStructuralNodeLabel(visibleNodeLabel(node));
    if (!parentLabel) continue;

    const repeatedDescendants = collectDescendants(nodes, node.index).filter(
      (descendant) =>
        !removed.has(descendant.index) &&
        isRepeatedActionRowDescendant(node, descendant, parentLabel),
    );
    for (const descendant of repeatedDescendants.filter(isPassiveRowContent)) {
      markNodeAndDescendantsForRemoval(nodes, descendant.index, removed);
    }

    const repeatedControls = repeatedDescendants.filter(
      (descendant) => !isPassiveRowContent(descendant),
    );
    const repeatedControlLabels = new Set(
      repeatedControls
        .map((descendant) => normalizeStructuralNodeLabel(visibleNodeLabel(descendant)))
        .filter((label): label is string => Boolean(label)),
    );
    if (repeatedControls.length < 2 || repeatedControlLabels.size < 2) continue;

    for (const descendant of repeatedControls) {
      markNodeAndDescendantsForRemoval(nodes, descendant.index, removed);
    }
  }
}

function isUnlabeledActionRow(node: SnapshotNode): boolean {
  return (
    node.hittable === true &&
    !isEditableNode(node) &&
    Boolean(node.rect && hasRenderableArea(node.rect)) &&
    visibleNodeLabel(node).trim().length === 0
  );
}

function collectPromotableRowContent(
  descendants: SnapshotNode[],
  parent: SnapshotNode,
  removed: Set<number>,
): { label: string; removableIndexes: number[] } {
  const labels: string[] = [];
  const removableIndexes: number[] = [];
  const seen = new Set<string>();
  for (const descendant of descendants) {
    if (
      removed.has(descendant.index) ||
      !isPassiveRowContent(descendant) ||
      !isRectContainedBy(descendant.rect, parent.rect)
    ) {
      continue;
    }
    const label = visibleNodeLabel(descendant).trim().replace(/\s+/g, ' ');
    const normalized = normalizeStructuralNodeLabel(label);
    removableIndexes.push(descendant.index);
    if (!label || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    labels.push(label);
  }
  return { label: labels.join(', '), removableIndexes };
}

function isPassiveRowContent(node: SnapshotNode): boolean {
  if (node.hittable === true || isEditableNode(node)) return false;
  const type = (node.type ?? '').toLowerCase();
  return type.includes('text') || type.includes('image') || type.includes('icon');
}

function isActionRowParent(node: SnapshotNode): boolean {
  return (
    node.hittable === true &&
    !isEditableNode(node) &&
    Boolean(node.rect && hasRenderableArea(node.rect)) &&
    Boolean(normalizeStructuralNodeLabel(visibleNodeLabel(node)))
  );
}

function isRepeatedActionRowDescendant(
  parent: SnapshotNode,
  node: SnapshotNode,
  parentLabel: string,
): boolean {
  if (!isStructuralNoiseCandidate(node) || !isRectContainedBy(node.rect, parent.rect)) {
    return false;
  }
  const label = normalizeStructuralNodeLabel(visibleNodeLabel(node));
  return Boolean(label && parentLabel !== label && parentLabel.includes(label));
}

function shouldCollapseAdjacentStructuralDuplicate(
  previous: SnapshotNode,
  node: SnapshotNode,
  removed: Set<number>,
): boolean {
  return (
    !removed.has(previous.index) &&
    areSameVisualRow(previous.rect, node.rect) &&
    (areStructurallyAdjacent(previous, node) || isPassiveChildOfActionableDuplicate(previous, node))
  );
}

function collapseAdjacentStructuralDuplicate(
  nodes: SnapshotNode[],
  previous: SnapshotNode,
  node: SnapshotNode,
  removed: Set<number>,
  replacements: Map<number, SnapshotNode>,
): SnapshotNode {
  const survivor = chooseStructuralRepresentative(previous, node);
  const collapsed = survivor.index === previous.index ? node : previous;
  const collapsedHint = (collapsed.type ?? '').toLowerCase().includes('image') ? 'has image' : null;
  const existing = replacements.get(survivor.index) ?? survivor;
  const collapsedHints =
    replacements.get(collapsed.index)?.presentationHints ?? collapsed.presentationHints;
  replacements.set(survivor.index, {
    ...existing,
    presentationHints: mergePresentationHints(
      existing.presentationHints,
      collapsedHints,
      collapsedHint,
    ),
  });
  markNodeAndDescendantsForRemoval(nodes, collapsed.index, removed);
  return replacements.get(survivor.index) ?? survivor;
}

function mergePresentationHints(
  current: SnapshotNode['presentationHints'],
  collapsed: SnapshotNode['presentationHints'],
  extra: string | null,
): string[] {
  return [
    ...new Set([
      ...(Array.isArray(current) ? current : []),
      ...(Array.isArray(collapsed) ? collapsed : []),
      ...(extra ? [extra] : []),
    ]),
  ];
}

function isStructuralNoiseCandidate(node: SnapshotNode): boolean {
  if (!node.rect || !hasRenderableArea(node.rect) || isRootNode(node) || isEditableNode(node)) {
    return false;
  }
  const type = (node.type ?? '').toLowerCase();
  return type === 'text' || hasAnyTypeToken(type, STRUCTURAL_NOISE_TYPE_TOKENS);
}

function chooseStructuralRepresentative(left: SnapshotNode, right: SnapshotNode): SnapshotNode {
  const leftScore = structuralRepresentativeScore(left);
  const rightScore = structuralRepresentativeScore(right);
  return rightScore > leftScore ? right : left;
}

function structuralRepresentativeScore(node: SnapshotNode): number {
  const type = (node.type ?? '').toLowerCase();
  let score = 0;
  if (hasAnyTypeToken(type, ACTIONABLE_STRUCTURAL_TYPE_TOKENS)) {
    score += 100;
  } else if (type.includes('image')) {
    score += 30;
  } else if (type.includes('textview') || type === 'text') {
    score += 20;
  } else if (type.includes('view')) {
    score += 10;
  }
  if (node.hittable === true) score += 20;
  if (node.enabled !== false) score += 5;
  return score;
}

function hasAnyTypeToken(type: string, tokens: string[]): boolean {
  return tokens.some((token) => type.includes(token));
}

function isPassiveChildOfActionableDuplicate(left: SnapshotNode, right: SnapshotNode): boolean {
  const parent =
    left.parentIndex === right.index ? right : right.parentIndex === left.index ? left : null;
  const child = parent?.index === left.index ? right : parent?.index === right.index ? left : null;
  if (!parent || !child) return false;
  return chooseStructuralRepresentative(parent, child).index === parent.index;
}

function areStructurallyAdjacent(left: SnapshotNode, right: SnapshotNode): boolean {
  if (left.parentIndex === right.parentIndex) {
    return Math.abs(left.index - right.index) <= 3;
  }
  if (left.parentIndex === right.index || right.parentIndex === left.index) {
    return false;
  }
  return (
    Math.abs((left.depth ?? 0) - (right.depth ?? 0)) <= 1 && Math.abs(left.index - right.index) <= 2
  );
}
