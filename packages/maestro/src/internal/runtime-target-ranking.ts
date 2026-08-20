import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { buildSnapshotNodeMap, normalizeType } from '@agent-device/contracts/snapshot';
import { isDescendantOfSnapshotNode } from './snapshot-policy.ts';
import { normalizeText } from './shared.ts';
import type { MaestroSelector } from './program-ir.ts';
import {
  createMaestroSnapshotResolver,
  selectMaestroIndexedNode,
  type MaestroSnapshotResolver,
} from './runtime-selector-resolution.ts';
import { type MaestroPositionRelation } from './runtime-target-position.ts';
import { filterVisibleMaestroMatches, type MaestroPlatform } from './runtime-target-policy.ts';
import {
  orderMaestroClickableFirst,
  resolveMaestroClickability,
  type MaestroClickabilityDecision,
} from './runtime-clickability.ts';

export type MaestroRankedCandidates = {
  readonly matches: SnapshotNode[];
  readonly visible: SnapshotNode[];
  readonly ranked: SnapshotNode[];
  readonly parentMatched: boolean;
  readonly clickability: MaestroClickabilityDecision;
};

export type MaestroCandidateMatches = Pick<MaestroRankedCandidates, 'matches' | 'parentMatched'>;

export function rankMaestroCandidates(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  platform: MaestroPlatform,
): MaestroRankedCandidates {
  const clickability = resolveMaestroClickability(snapshot, platform);
  const resolver = createMaestroResolver(snapshot, clickability);
  const scoped = matchMaestroCandidatesWithResolver(selector, resolver);
  const visible = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches: scoped.matches,
    platform,
  });
  return {
    ...scoped,
    visible,
    clickability,
    ranked: rankVisibleMaestroMatches(
      snapshot.nodes,
      visible,
      selector,
      platform,
      resolver.nodeByIndex,
      clickability,
    ),
  };
}

export function matchMaestroCandidatesWithResolver(
  selector: MaestroSelector,
  resolver: MaestroSnapshotResolver,
): MaestroCandidateMatches {
  const matches = resolver.resolve(selector).matches;
  const parentMatched =
    selector.childOf === undefined || resolver.resolve(selector.childOf).indexed.length > 0;
  return { matches, parentMatched };
}

export function selectMaestroSnapshotMatches(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  platform?: MaestroPlatform,
): SnapshotNode[] {
  const clickability = platform ? resolveMaestroClickability(snapshot, platform) : undefined;
  return createMaestroResolver(snapshot, clickability).resolve(selector).indexed;
}

export function selectMaestroPositionMatches(
  snapshot: SnapshotState,
  relation: MaestroPositionRelation,
  anchor: MaestroSelector,
  platform?: MaestroPlatform,
): SnapshotNode[] {
  const clickability = platform ? resolveMaestroClickability(snapshot, platform) : undefined;
  return createMaestroResolver(snapshot, clickability).resolvePosition(relation, anchor);
}

function createMaestroResolver(
  snapshot: SnapshotState,
  clickability: MaestroClickabilityDecision | undefined,
): MaestroSnapshotResolver {
  return createMaestroSnapshotResolver(
    snapshot,
    {},
    clickability
      ? { orderUnindexed: (matches) => orderMaestroClickableFirst(matches, clickability) }
      : {},
  );
}

export function rankVisibleMaestroMatches(
  nodes: SnapshotNode[],
  matches: SnapshotNode[],
  selector: MaestroSelector,
  platform: MaestroPlatform,
  nodeByIndex: ReadonlyMap<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
  clickability?: MaestroClickabilityDecision,
): SnapshotNode[] {
  const ranked =
    platform !== 'ios' || !hasTextualSelector(selector)
      ? matches
      : matches.filter((candidate) => {
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
  return selector.index === undefined && clickability
    ? orderMaestroClickableFirst(ranked, clickability)
    : ranked;
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
  return selectMaestroIndexedNode(matches, index);
}

export function usableRect(node: SnapshotNode): Rect | undefined {
  return hasUsableRect(node) ? node.rect : undefined;
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
