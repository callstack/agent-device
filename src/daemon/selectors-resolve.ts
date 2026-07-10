import type { Platform, PublicPlatform } from '../kernel/device.ts';
import type { DisambiguationTiebreak } from '../contracts/interaction.ts';
import type { SnapshotNode, SnapshotState } from '../kernel/snapshot.ts';
import { isNodeVisibleOnScreen } from '../snapshot/mobile-snapshot-semantics.ts';
import { buildSnapshotNodeMap } from '../snapshot/snapshot-tree.ts';
import { matchesSelector } from './selectors-match.ts';
import type { Selector, SelectorChain } from './selectors-parse.ts';

export type SelectorDiagnostics = {
  selector: string;
  matches: number;
};

/** Present only when the heuristic picked among N>1 matches (ADR 0012). */
export type SelectorDisambiguationDisclosure = {
  matchCount: number;
  tiebreak: DisambiguationTiebreak;
  /** Every losing matched node, document order, uncapped (response layer caps). */
  alternatives: SnapshotNode[];
};

export type SelectorResolution = {
  node: SnapshotNode;
  selector: Selector;
  selectorIndex: number;
  matches: number;
  diagnostics: SelectorDiagnostics[];
  disambiguation?: SelectorDisambiguationDisclosure;
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
      if (!options.disambiguateAmbiguous || !summary.disambiguated || !summary.tiebreak) continue;
      return {
        node: summary.disambiguated,
        selector,
        selectorIndex: i,
        matches: summary.count,
        diagnostics,
        disambiguation: {
          matchCount: summary.count,
          tiebreak: summary.tiebreak,
          alternatives: summary.candidates.filter(
            (candidate) => candidate !== summary.disambiguated,
          ),
        },
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

type DisambiguationState = {
  best: SnapshotNode | null;
  bestVisible: boolean;
  tie: boolean;
};

function analyzeSelectorMatches(
  nodes: SnapshotState['nodes'],
  selector: Selector,
  platform: Platform | PublicPlatform,
  requireRect: boolean,
): {
  count: number;
  firstNode: SnapshotNode | null;
  disambiguated: SnapshotNode | null;
  tiebreak: DisambiguationTiebreak | null;
  /** Every matched node (winner included), document order. */
  candidates: SnapshotNode[];
} {
  let count = 0;
  let firstNode: SnapshotNode | null = null;
  const candidates: SnapshotNode[] = [];
  const state: DisambiguationState = { best: null, bestVisible: false, tie: false };
  // Lazily built: only ambiguous matches pay for viewport inference.
  let byIndex: Map<number, SnapshotNode> | undefined;
  const isVisible = (node: SnapshotNode): boolean => {
    byIndex ??= buildSnapshotNodeMap(nodes);
    return isNodeVisibleOnScreen(node, nodes, byIndex);
  };
  for (const node of nodes) {
    if (requireRect && !node.rect) continue;
    if (!matchesSelector(node, selector, platform)) continue;
    count += 1;
    firstNode ??= node;
    candidates.push(node);
    accumulateDisambiguationCandidate(state, node, isVisible);
  }
  return {
    count,
    firstNode,
    disambiguated: state.tie ? null : state.best,
    tiebreak: state.tie ? null : findDecidingTiebreak(candidates, state.best, isVisible),
    candidates,
  };
}

// A closed drawer or off-viewport carousel keeps its items in the tree at
// out-of-bounds rects; picking one silently taps coordinates that cannot land.
// Prefer candidates visible on screen before the deepest-then-smallest
// tiebreak (visibility is evaluated only once matches are ambiguous, so
// unique resolutions never pay for viewport inference).
function accumulateDisambiguationCandidate(
  state: DisambiguationState,
  node: SnapshotNode,
  isVisible: (node: SnapshotNode) => boolean,
): void {
  if (!state.best) {
    state.best = node;
    return;
  }
  state.bestVisible ||= isVisible(state.best);
  const nodeVisible = isVisible(node);
  if (nodeVisible !== state.bestVisible) {
    if (nodeVisible) {
      state.best = node;
      state.bestVisible = true;
      state.tie = false;
    }
    return;
  }
  const comparison = compareDisambiguationCandidates(node, state.best);
  if (comparison.result > 0) {
    state.best = node;
    state.tie = false;
  } else if (comparison.result === 0) {
    state.tie = true;
  }
}

// Disclosure only (winner vs strongest challenger); never picks the winner.
function findDecidingTiebreak(
  candidates: readonly SnapshotNode[],
  winner: SnapshotNode | null,
  isVisible: (node: SnapshotNode) => boolean,
): DisambiguationTiebreak | null {
  if (!winner) return null;
  let runnerUp: SnapshotNode | null = null;
  for (const candidate of candidates) {
    if (candidate === winner) continue;
    if (!runnerUp || compareCandidatesWithVisibility(candidate, runnerUp, isVisible).result > 0) {
      runnerUp = candidate;
    }
  }
  return runnerUp ? compareCandidatesWithVisibility(winner, runnerUp, isVisible).criterion : null;
}

function compareCandidatesWithVisibility(
  a: SnapshotNode,
  b: SnapshotNode,
  isVisible: (node: SnapshotNode) => boolean,
): DisambiguationComparison {
  const visibleA = isVisible(a);
  const visibleB = isVisible(b);
  if (visibleA !== visibleB) {
    return { result: visibleA ? 1 : -1, criterion: 'visible' };
  }
  return compareDisambiguationCandidates(a, b);
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

type DisambiguationComparison = {
  result: number;
  /** The criterion that decided this pairwise comparison; null only on an exact tie. */
  criterion: DisambiguationTiebreak | null;
};

function compareDisambiguationCandidates(
  a: SnapshotNode,
  b: SnapshotNode,
): DisambiguationComparison {
  const depthA = a.depth ?? 0;
  const depthB = b.depth ?? 0;
  if (depthA !== depthB) return { result: depthA > depthB ? 1 : -1, criterion: 'deepest' };
  const areaA = areaOfNode(a);
  const areaB = areaOfNode(b);
  if (areaA !== areaB) return { result: areaA < areaB ? 1 : -1, criterion: 'smallest-area' };
  return { result: 0, criterion: null };
}

function areaOfNode(node: SnapshotNode): number {
  return node.rect ? node.rect.width * node.rect.height : Number.POSITIVE_INFINITY;
}
