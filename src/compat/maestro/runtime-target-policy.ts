import type { MaestroSelector } from './program-ir.ts';
import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import { evaluateIsPredicate } from '../../selectors/predicates.ts';
import { normalizeText } from '../../selectors/find.ts';
import { matchesMaestroRegex } from './selector-regex.ts';
import { extractNodeText } from '../../snapshot/snapshot-processing.ts';
import {
  detectReactNativeOverlay,
  readReactNativeOverlayActionNodes,
} from '../../core/react-native-overlay.ts';

export type MaestroPlatform = 'ios' | 'android';

export type MaestroResolvedSnapshotMatch = {
  node: SnapshotNode;
  rect: NonNullable<SnapshotNode['rect']>;
  inheritedRect: boolean;
};

export type MaestroPreferredContext = {
  node: SnapshotNode;
  rect: NonNullable<SnapshotNode['rect']>;
};

export type ReactNativeOverlayFilterResult = {
  matches: SnapshotNode[];
  blockedByReactNativeOverlay: boolean;
};

/**
 * Match the source-preserving selector IR directly. In particular, this does
 * not lower the selector to the legacy `key=value` expression grammar.
 *
 * Maestro's compatibility parser treats id as the strongest primary field,
 * then text, then label. Primary values are full-match regular expressions.
 * Text is the visible-text form used by scalar
 * selectors, so it checks label, readable node text, and identifier values.
 * Enabled and selected are independent state constraints.
 */
export function matchesMaestroTypedSelector(
  node: SnapshotNode,
  selector: MaestroSelector,
): boolean {
  const primary = readTypedPrimarySelector(selector);
  if (primary) {
    const matched =
      primary.key === 'text'
        ? matchesMaestroVisibleText(node, primary.value)
        : matchesMaestroSelectorValue(readMaestroTextTermValue(node, primary.key), primary.value);
    if (!matched) return false;
  } else if (selector.enabled === undefined && selector.selected === undefined) {
    return false;
  }

  if (selector.enabled !== undefined && Boolean(node.enabled !== false) !== selector.enabled) {
    return false;
  }
  if (selector.selected !== undefined && Boolean(node.selected === true) !== selector.selected) {
    return false;
  }
  return true;
}

/** Read the visible-text fallback query represented by the typed selector. */
export function extractMaestroVisibleTextQueryFromSelector(
  selector: MaestroSelector,
): string | null {
  if (selector.id !== undefined) return null;
  const query = selector.text ?? selector.label;
  return query ?? null;
}

export function filterVisibleMaestroMatches(params: {
  nodes: SnapshotState['nodes'];
  matches: SnapshotNode[];
  platform: MaestroPlatform;
}): ReactNativeOverlayFilterResult {
  const visibleMatches = params.matches.filter(
    (node) =>
      evaluateIsPredicate({
        predicate: 'visible',
        node,
        nodes: params.nodes,
        platform: params.platform,
      }).pass,
  );
  const overlayFilter = filterReactNativeOverlayBlockedMatches(
    params.nodes,
    visibleMatches,
    params.platform,
  );
  return {
    matches: overlayFilter.matches,
    blockedByReactNativeOverlay: overlayFilter.blockedByReactNativeOverlay,
  };
}

function filterReactNativeOverlayBlockedMatches(
  nodes: SnapshotState['nodes'],
  matches: SnapshotNode[],
  platform: MaestroPlatform,
): ReactNativeOverlayFilterResult {
  const overlay = detectReactNativeOverlay(nodes);
  if (!overlay.detected || !overlay.redBox) {
    return { matches, blockedByReactNativeOverlay: false };
  }

  const overlayControls = readReactNativeOverlayActionNodes(overlay);
  const visibleOverlayControls = overlayControls.filter(
    (node) =>
      evaluateIsPredicate({
        predicate: 'visible',
        node,
        nodes,
        platform,
      }).pass,
  );
  if (visibleOverlayControls.length === 0) {
    if (overlayControls.length === 0) {
      return { matches: [], blockedByReactNativeOverlay: true };
    }
    return { matches, blockedByReactNativeOverlay: false };
  }

  const overlayNodeIndexes = new Set(visibleOverlayControls.map((node) => node.index));
  const overlayMatches = matches.filter((node) => overlayNodeIndexes.has(node.index));
  return {
    matches: overlayMatches,
    blockedByReactNativeOverlay: matches.length > 0 && overlayMatches.length === 0,
  };
}

export function maestroVisibleTextMatchRank(node: SnapshotNode, query: string): number {
  const values = [node.label, extractNodeText(node), node.identifier, node.value].filter(
    (value): value is string => Boolean(value),
  );
  if (values.some((value) => value === query)) return 0;
  if (values.some((value) => normalizeText(value) === normalizeText(query))) return 1;
  if (values.some((value) => matchesMaestroRegex(value, query))) return 2;
  return 3;
}

function matchesMaestroSelectorValue(value: string | undefined, query: string): boolean {
  const text = value ?? '';
  const normalizedText = normalizeText(text);
  const normalizedQuery = normalizeText(query);
  if (normalizedText === normalizedQuery) return true;
  if (isLeadingCompositeLabelMatch(normalizedText, normalizedQuery)) {
    return true;
  }
  return matchesMaestroRegex(text, query);
}

function readTypedPrimarySelector(
  selector: MaestroSelector,
): { key: 'id' | 'text' | 'label'; value: string } | null {
  if (selector.id !== undefined) return { key: 'id', value: selector.id };
  if (selector.text !== undefined) return { key: 'text', value: selector.text };
  if (selector.label !== undefined) return { key: 'label', value: selector.label };
  return null;
}

function matchesMaestroVisibleText(node: SnapshotNode, query: string): boolean {
  return [node.label, extractNodeText(node), node.identifier]
    .filter((value): value is string => Boolean(value))
    .some((value) => matchesMaestroSelectorValue(value, query));
}

function readMaestroTextTermValue(
  node: SnapshotNode,
  key: 'id' | 'label' | 'text',
): string | undefined {
  if (key === 'id') return node.identifier;
  if (key === 'label') return node.label;
  return extractNodeText(node);
}

function isLeadingCompositeLabelMatch(normalizedText: string, normalizedQuery: string): boolean {
  if (!normalizedText || !normalizedQuery) return false;
  if (!normalizedText.startsWith(normalizedQuery)) return false;
  const next = normalizedText.at(normalizedQuery.length);
  return next === ',' || next === ':' || next === ';';
}
