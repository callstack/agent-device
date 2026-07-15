import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import { isPositiveFiniteRect } from '../../kernel/rect.ts';
import {
  buildSnapshotNodeByIndex,
  isDescendantOfSnapshotNode,
  normalizeType,
} from '../../snapshot/snapshot-processing.ts';
import { normalizeText } from '../../selectors/find.ts';
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

export function rankMaestroCandidates(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  platform: MaestroPlatform,
  childOf?: MaestroSelector,
): MaestroRankedCandidates {
  const matches = snapshot.nodes.filter((node) => matchesMaestroTypedSelector(node, selector));
  const scoped = scopeMatchesByAncestor(snapshot, matches, childOf);
  const visible = filterVisibleMaestroMatches({
    nodes: snapshot.nodes,
    matches: scoped.matches,
    platform,
  });
  return {
    matches: scoped.matches,
    visible,
    ranked: normalizeMaestroSnapshotMatches(snapshot.nodes, visible, selector, platform),
    parentMatched: scoped.parentMatched,
  };
}

function normalizeMaestroSnapshotMatches(
  nodes: SnapshotNode[],
  matches: SnapshotNode[],
  selector: MaestroSelector,
  platform: MaestroPlatform,
): SnapshotNode[] {
  if (platform !== 'ios' || !hasTextualSelector(selector)) return matches;
  const nodeByIndex = buildSnapshotNodeByIndex(nodes);
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
  index: number | undefined,
): { node: SnapshotNode; rect: Rect } | null {
  const selected = index === undefined ? matches.find(hasUsableRect) : matches[index];
  if (!selected || !hasUsableRect(selected)) return null;
  return { node: selected, rect: selected.rect };
}

function hasUsableRect(node: SnapshotNode): node is SnapshotNode & { rect: Rect } {
  return isPositiveFiniteRect(node.rect);
}

function hasTextualSelector(selector: MaestroSelector): boolean {
  return selector.id !== undefined || selector.label !== undefined || selector.text !== undefined;
}

function haveSameSelectorIdentity(
  left: SnapshotNode,
  right: SnapshotNode,
  selector: MaestroSelector,
): boolean {
  if (selector.id !== undefined && normalize(left.identifier) !== normalize(right.identifier)) {
    return false;
  }
  if (selector.label !== undefined && normalize(left.label) !== normalize(right.label)) {
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

function scopeMatchesByAncestor(
  snapshot: SnapshotState,
  matches: SnapshotNode[],
  childOf: MaestroSelector | undefined,
): { matches: SnapshotNode[]; parentMatched: boolean } {
  if (!childOf) return { matches, parentMatched: true };
  const parents = snapshot.nodes.filter((node) => matchesMaestroTypedSelector(node, childOf));
  if (parents.length === 0) return { matches: [], parentMatched: false };
  const nodeByIndex = buildSnapshotNodeByIndex(snapshot.nodes);
  return {
    matches: matches.filter((node) =>
      parents.some((parent) =>
        isDescendantOfSnapshotNode(snapshot.nodes, node, parent, nodeByIndex),
      ),
    ),
    parentMatched: true,
  };
}
