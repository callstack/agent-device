import type { Platform, PublicPlatform } from '../kernel/device.ts';
import type { SnapshotNode, SnapshotState } from '../kernel/snapshot.ts';
import { matchesSelector } from './selectors-match.ts';
import type { Selector, SelectorChain } from './selectors-parse.ts';

export type SelectorDiagnostics = {
  selector: string;
  matches: number;
};

export type SelectorResolution = {
  node: SnapshotNode;
  selector: Selector;
  selectorIndex: number;
  matches: number;
  diagnostics: SelectorDiagnostics[];
};

export function resolveSelectorChain(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  options: {
    platform: Platform | PublicPlatform;
    requireRect?: boolean;
    requireUnique?: boolean;
    disambiguateAmbiguous?: boolean;
  },
): SelectorResolution | null {
  const requireRect = options.requireRect ?? false;
  const requireUnique = options.requireUnique ?? true;
  const diagnostics: SelectorDiagnostics[] = [];
  for (const [i, selector] of chain.selectors.entries()) {
    const summary = analyzeSelectorMatches(nodes, selector, options.platform, requireRect);
    diagnostics.push({ selector: selector.raw, matches: summary.count });
    if (summary.count === 0 || !summary.firstNode) continue;
    if (requireUnique && summary.count !== 1) {
      if (!options.disambiguateAmbiguous || !summary.disambiguated) continue;
      return {
        node: summary.disambiguated,
        selector,
        selectorIndex: i,
        matches: summary.count,
        diagnostics,
      };
    }
    return {
      node: summary.firstNode,
      selector,
      selectorIndex: i,
      matches: summary.count,
      diagnostics,
    };
  }
  return null;
}

export function findSelectorChainMatch(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  options: {
    platform: Platform | PublicPlatform;
    requireRect?: boolean;
  },
): {
  selectorIndex: number;
  selector: Selector;
  matches: number;
  diagnostics: SelectorDiagnostics[];
} | null {
  const requireRect = options.requireRect ?? false;
  const diagnostics: SelectorDiagnostics[] = [];
  for (const [i, selector] of chain.selectors.entries()) {
    const matches = countSelectorMatchesOnly(nodes, selector, options.platform, requireRect);
    diagnostics.push({ selector: selector.raw, matches });
    if (matches > 0) {
      return { selectorIndex: i, selector, matches, diagnostics };
    }
  }
  return null;
}

const SELECTOR_NO_MATCH_HINT =
  'Selector text/label values match exactly (quote multi-word values: text="Sign in"). Run snapshot -i to see current elements and refs, or use find <text> for contains matching.';

const SELECTOR_NOT_UNIQUE_HINT =
  'Add more terms to disambiguate (e.g. role=button text="Sign in"), use an @ref from snapshot -i, or use find <text> --first/--last.';

export const STALE_REF_HINT =
  'Snapshot refs expire when the UI changes. Run snapshot -i and retry with a fresh @ref.';

export function selectorFailureHint(diagnostics: SelectorDiagnostics[]): string {
  return diagnostics.some((entry) => entry.matches > 1)
    ? SELECTOR_NOT_UNIQUE_HINT
    : SELECTOR_NO_MATCH_HINT;
}

export function formatSelectorFailure(
  chain: SelectorChain,
  diagnostics: SelectorDiagnostics[],
  options: { unique?: boolean },
): string {
  if (diagnostics.length === 0) {
    return `Selector did not match: ${chain.raw}`;
  }
  const summary = diagnostics.map((entry) => `${entry.selector} -> ${entry.matches}`).join(', ');
  return (options.unique ?? true)
    ? `Selector did not resolve uniquely (${summary})`
    : `Selector did not match (${summary})`;
}

function analyzeSelectorMatches(
  nodes: SnapshotState['nodes'],
  selector: Selector,
  platform: Platform | PublicPlatform,
  requireRect: boolean,
): { count: number; firstNode: SnapshotNode | null; disambiguated: SnapshotNode | null } {
  let count = 0;
  let firstNode: SnapshotNode | null = null;
  let best: SnapshotNode | null = null;
  let tie = false;
  for (const node of nodes) {
    if (requireRect && !node.rect) continue;
    if (!matchesSelector(node, selector, platform)) continue;
    count += 1;
    firstNode ??= node;
    if (!best) {
      best = node;
      continue;
    }
    const comparison = compareDisambiguationCandidates(node, best);
    if (comparison > 0) {
      best = node;
      tie = false;
    } else if (comparison === 0) {
      tie = true;
    }
  }
  return {
    count,
    firstNode,
    disambiguated: tie ? null : best,
  };
}

function countSelectorMatchesOnly(
  nodes: SnapshotState['nodes'],
  selector: Selector,
  platform: Platform | PublicPlatform,
  requireRect: boolean,
): number {
  let count = 0;
  for (const node of nodes) {
    if (requireRect && !node.rect) continue;
    if (!matchesSelector(node, selector, platform)) continue;
    count += 1;
  }
  return count;
}

function compareDisambiguationCandidates(a: SnapshotNode, b: SnapshotNode): number {
  const depthA = a.depth ?? 0;
  const depthB = b.depth ?? 0;
  if (depthA !== depthB) return depthA > depthB ? 1 : -1;
  const areaA = areaOfNode(a);
  const areaB = areaOfNode(b);
  if (areaA !== areaB) return areaA < areaB ? 1 : -1;
  return 0;
}

function areaOfNode(node: SnapshotNode): number {
  return node.rect ? node.rect.width * node.rect.height : Number.POSITIVE_INFINITY;
}
