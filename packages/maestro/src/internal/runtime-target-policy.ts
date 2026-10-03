import type { MaestroLeafSelector, MaestroRelationalSelectorFields } from './program-ir.ts';

export type MaestroFlatSelector = MaestroLeafSelector & {
  [Key in keyof MaestroRelationalSelectorFields]?: never;
};
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotVisibility } from '@agent-device/contracts/snapshot';
import { matchesMaestroRegex } from './selector-regex.ts';
import { extractNodeText, normalizeText } from './shared.ts';
import { isMaestroNodeVisible } from './snapshot-policy.ts';

export type MaestroPlatform = 'ios' | 'android';

/**
 * Match the source-preserving selector IR directly. In particular, this does
 * not lower the selector to the legacy `key=value` expression grammar.
 *
 * Maestro intersects every authored selector field. String values are
 * full-match regular expressions. Text is the visible-text form used by
 * scalar selectors, so it checks label, readable node text, and identifier
 * values; `label` itself is command metadata, never a selector field. Enabled
 * and selected are independent state constraints.
 */
export function matchesMaestroTypedSelector(
  node: SnapshotNode,
  selector: MaestroFlatSelector,
): boolean {
  const textTerms = [
    selector.id === undefined
      ? undefined
      : matchesMaestroSelectorValue(node.identifier, selector.id),
    selector.text === undefined ? undefined : matchesMaestroVisibleText(node, selector.text),
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
  visibility: SnapshotVisibility;
  matches: SnapshotNode[];
  platform: MaestroPlatform;
}): SnapshotNode[] {
  return params.matches.filter((node) =>
    isMaestroNodeVisible(node, params.visibility, params.platform),
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
