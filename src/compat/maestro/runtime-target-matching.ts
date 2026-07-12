import type { MaestroSelector } from './program-ir.ts';
import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import { extractNodeText } from '../../snapshot/snapshot-processing.ts';
import { normalizeText } from '../../selectors/find.ts';
import type { Selector } from '../../selectors/arguments.ts';
import {
  matchesMaestroSelector,
  matchesMaestroTypedSelector,
  type MaestroPlatform,
  type MaestroSelectorMatchOptions,
} from './runtime-target-policy.ts';

/** Resolve the first non-empty selector in a parsed legacy selector chain. */
export function findMaestroSelectorMatches(
  snapshot: SnapshotState,
  selectors: readonly Selector[],
  platform: MaestroPlatform,
  options: MaestroSelectorMatchOptions = {},
): SnapshotNode[] {
  for (const selector of selectors) {
    const matches = snapshot.nodes.filter((node) =>
      matchesMaestroSelector(node, selector, platform, options),
    );
    if (matches.length > 0) return matches;
  }
  return [];
}

/** Resolve a source-preserving Maestro selector without stringifying it. */
export function findMaestroTypedSelectorMatches(
  snapshot: SnapshotState,
  selector: MaestroSelector,
  options: MaestroSelectorMatchOptions = {},
): SnapshotNode[] {
  return snapshot.nodes.filter((node) =>
    matchesMaestroTypedSelector(node, selector, options),
  );
}

export function findMaestroFuzzyTextMatches(
  snapshot: SnapshotState,
  query: string,
): SnapshotNode[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];
  const exact: SnapshotNode[] = [];
  const partial: SnapshotNode[] = [];
  for (const node of snapshot.nodes) {
    const values = [node.label, extractNodeText(node), node.identifier, node.value].filter(
      (value): value is string => Boolean(value),
    );
    const normalizedValues = values.map((value) => normalizeText(value));
    if (normalizedValues.some((value) => value === normalizedQuery)) {
      exact.push(node);
    } else if (normalizedValues.some((value) => value.includes(normalizedQuery))) {
      partial.push(node);
    }
  }
  return exact.length > 0 ? exact : partial;
}
