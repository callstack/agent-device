import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { buildSnapshotNodeMap, normalizeType } from '@agent-device/contracts/snapshot';
import { isDescendantOfSnapshotNode } from './snapshot-policy.ts';
import { normalizeText } from './shared.ts';
import type { MaestroSelector } from './program-ir.ts';
import {
  filterVisibleMaestroMatches,
  matchesMaestroTypedSelector,
  type MaestroPlatform,
} from './runtime-target-policy.ts';

export type MaestroRankedCandidates = {
  readonly matches: SnapshotNode[];
  readonly visible: SnapshotNode[];
  readonly ranked: SnapshotNode[];
  readonly parentMatched: boolean;
};

export type MaestroCandidateMatches = Pick<MaestroRankedCandidates, 'matches' | 'parentMatched'>;

export function rankMaestroCandidates(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  platform: MaestroPlatform,
): MaestroRankedCandidates {
  const scoped = matchMaestroCandidates(snapshot, selector);
  const visible = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches: scoped.matches,
    platform,
  });
  return {
    ...scoped,
    visible,
    ranked: rankVisibleMaestroMatches(snapshot.nodes, visible, selector, platform),
  };
}

export function matchMaestroCandidates(
  snapshot: SnapshotState,
  selector: MaestroSelector,
): MaestroCandidateMatches {
  const matches = selectMaestroSnapshotMatchesWithoutOwnIndex(snapshot, selector);
  const parentMatched =
    selector.childOf === undefined ||
    selectMaestroSnapshotMatches(snapshot, selector.childOf).length > 0;
  return { matches, parentMatched };
}

export function selectMaestroSnapshotMatches(
  snapshot: SnapshotState,
  selector: MaestroSelector,
): SnapshotNode[] {
  const matches = selectMaestroSnapshotMatchesWithoutOwnIndex(snapshot, selector);
  if (selector.index === undefined) return matches;
  const selected = sortMaestroMatchesForIndex(matches)[resolveMaestroSelectorIndex(selector.index)];
  return selected ? [selected] : [];
}

function selectMaestroSnapshotMatchesWithoutOwnIndex(
  snapshot: SnapshotState,
  selector: MaestroSelector,
): SnapshotNode[] {
  return snapshot.nodes.filter((node) =>
    matchesMaestroSnapshotSelectorWithoutOwnIndex(snapshot, node, selector),
  );
}

function matchesMaestroSnapshotSelectorWithoutOwnIndex(
  snapshot: SnapshotState,
  node: SnapshotNode,
  selector: MaestroSelector,
): boolean {
  const { index: _index, childOf, containsChild, containsDescendants, ...flat } = selector;
  if (!matchesMaestroTypedSelector(node, flat)) return false;
  return matchesMaestroAncestorRelations(
    snapshot,
    node,
    childOf,
    containsChild,
    containsDescendants,
  );
}

function matchesMaestroAncestorRelations(
  snapshot: SnapshotState,
  node: SnapshotNode,
  childOf: MaestroSelector | undefined,
  containsChild: MaestroSelector | undefined,
  containsDescendants: MaestroSelector[] | undefined,
): boolean {
  const byIndex = buildSnapshotNodeMap(snapshot.nodes);
  if (childOf) {
    const scopedParents = selectMaestroSnapshotMatches(snapshot, childOf);
    if (
      !scopedParents.some((candidate) =>
        isDescendantOfSnapshotNode(snapshot.nodes, node, candidate, byIndex),
      )
    )
      return false;
  }
  if (!matchesMaestroContainsChild(snapshot, node, containsChild)) return false;
  return matchesMaestroContainsDescendants(snapshot, node, containsDescendants, byIndex);
}

function matchesMaestroContainsChild(
  snapshot: SnapshotState,
  node: SnapshotNode,
  selector: MaestroSelector | undefined,
): boolean {
  if (!selector) return true;
  const matches = selectMaestroSnapshotMatches(snapshot, selector);
  return snapshot.nodes.some(
    (candidate) => candidate.parentIndex === node.index && matches.includes(candidate),
  );
}

function matchesMaestroContainsDescendants(
  snapshot: SnapshotState,
  node: SnapshotNode,
  selectors: MaestroSelector[] | undefined,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  if (!selectors) return true;
  return selectors.every((selector) => {
    const matches = selectMaestroSnapshotMatches(snapshot, selector);
    return matches.some((candidate) =>
      isDescendantOfSnapshotNode(snapshot.nodes, candidate, node, byIndex),
    );
  });
}
export function rankVisibleMaestroMatches(
  nodes: SnapshotNode[],
  matches: SnapshotNode[],
  selector: MaestroSelector,
  platform: MaestroPlatform,
): SnapshotNode[] {
  if (platform !== 'ios' || !hasTextualSelector(selector)) return matches;
  const nodeByIndex = buildSnapshotNodeMap(nodes);
  return matches.filter((candidate) => {
    if (isInteractiveControl(candidate)) return true;
    const equivalentMatches = matches.filter(
      (other) => other !== candidate && haveSameSelectorIdentity(candidate, other, selector),
    );
    if (
      equivalentMatches.some(
        (other) =>
          isInteractiveControl(other) &&
          isDescendantOfSnapshotNode(nodes, candidate, other, nodeByIndex),
      )
    ) {
      return false;
    }
    return !equivalentMatches.some((other) =>
      isDescendantOfSnapshotNode(nodes, other, candidate, nodeByIndex),
    );
  });
}

export function selectMaestroSnapshotMatch(
  matches: SnapshotNode[],
  index: number | string | undefined,
): { node: SnapshotNode; rect: Rect } | null {
  const selected =
    index === undefined ? matches.find(hasUsableRect) : selectMaestroSnapshotNode(matches, index);
  if (!selected || !hasUsableRect(selected)) return null;
  return { node: selected, rect: selected.rect };
}

export function selectMaestroSnapshotNode(
  matches: SnapshotNode[],
  index: number | string | undefined,
): SnapshotNode | undefined {
  return index === undefined
    ? matches[0]
    : sortMaestroMatchesForIndex(matches)[resolveMaestroSelectorIndex(index)];
}

export function usableRect(node: SnapshotNode): Rect | undefined {
  return hasUsableRect(node) ? node.rect : undefined;
}

function sortMaestroMatchesForIndex(matches: SnapshotNode[]): SnapshotNode[] {
  return [...matches].sort((left, right) => {
    const leftY = finiteCoordinate(left.rect?.y);
    const rightY = finiteCoordinate(right.rect?.y);
    if (leftY !== rightY) return leftY - rightY;
    return finiteCoordinate(left.rect?.x) - finiteCoordinate(right.rect?.x);
  });
}

function finiteCoordinate(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function resolveMaestroSelectorIndex(value: number | string): number {
  const index = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new AppError('INVALID_ARGS', 'Maestro selector.index must be a non-negative integer.');
  }
  return index;
}

function hasUsableRect(node: SnapshotNode): node is SnapshotNode & { rect: Rect } {
  return isPositiveFiniteRect(node.rect);
}

function hasTextualSelector(selector: MaestroSelector): boolean {
  return selector.id !== undefined || selector.text !== undefined;
}

function haveSameSelectorIdentity(
  left: SnapshotNode,
  right: SnapshotNode,
  selector: MaestroSelector,
): boolean {
  if (selector.id !== undefined && normalize(left.identifier) !== normalize(right.identifier)) {
    return false;
  }
  if (selector.text !== undefined) {
    const leftText = visibleTextValues(left);
    const rightText = new Set(visibleTextValues(right));
    if (!leftText.some((value) => rightText.has(value))) return false;
  }
  return true;
}

function visibleTextValues(node: SnapshotNode): string[] {
  return [node.label, node.value, node.identifier]
    .map(normalize)
    .filter((value): value is string => value !== undefined);
}

function normalize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function isInteractiveControl(node: SnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return (
    type === 'button' ||
    type === 'link' ||
    type === 'switch' ||
    type === 'searchfield' ||
    type === 'textfield' ||
    type === 'securetextfield' ||
    type === 'textview'
  );
}
