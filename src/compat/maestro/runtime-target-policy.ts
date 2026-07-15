import type { MaestroSelector } from './program-ir.ts';
import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import { evaluateIsPredicate } from '../../selectors/predicates.ts';
import { normalizeText } from '../../selectors/find.ts';
import { matchesMaestroRegex } from './selector-regex.ts';
import { extractNodeText } from '../../snapshot/snapshot-processing.ts';

export type MaestroPlatform = 'ios' | 'android';

/**
 * Match the source-preserving selector IR directly. In particular, this does
 * not lower the selector to the legacy `key=value` expression grammar.
 *
 * Maestro intersects every authored selector field. String values are
 * full-match regular expressions. Text is the visible-text form used by
 * scalar selectors, so it checks label, readable node text, and identifier
 * values. Enabled and selected are independent state constraints.
 */
export function matchesMaestroTypedSelector(
  node: SnapshotNode,
  selector: MaestroSelector,
): boolean {
  const textTerms = [
    selector.id === undefined
      ? undefined
      : matchesMaestroSelectorValue(node.identifier, selector.id),
    selector.text === undefined ? undefined : matchesMaestroVisibleText(node, selector.text),
    selector.label === undefined
      ? undefined
      : matchesMaestroSelectorValue(node.label, selector.label),
  ].filter((matched): matched is boolean => matched !== undefined);
  if (textTerms.length === 0 && selector.enabled === undefined && selector.selected === undefined) {
    return false;
  }
  if (textTerms.some((matched) => !matched)) return false;

  if (selector.enabled !== undefined && Boolean(node.enabled !== false) !== selector.enabled) {
    return false;
  }
  if (selector.selected !== undefined && Boolean(node.selected === true) !== selector.selected) {
    return false;
  }
  return true;
}

export function filterVisibleMaestroMatches(params: {
  nodes: SnapshotState['nodes'];
  matches: SnapshotNode[];
  platform: MaestroPlatform;
}): SnapshotNode[] {
  return params.matches.filter(
    (node) =>
      evaluateIsPredicate({
        predicate: 'visible',
        node,
        nodes: params.nodes,
        platform: params.platform,
      }).pass,
  );
}

function matchesMaestroSelectorValue(value: string | undefined, query: string): boolean {
  const text = value ?? '';
  const normalizedText = normalizeText(text);
  const normalizedQuery = normalizeText(query);
  if (normalizedText === normalizedQuery) return true;
  return matchesMaestroRegex(text, query);
}

function matchesMaestroVisibleText(node: SnapshotNode, query: string): boolean {
  return [node.label, extractNodeText(node), node.identifier]
    .filter((value): value is string => Boolean(value))
    .some((value) => matchesMaestroSelectorValue(value, query));
}
