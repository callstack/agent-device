import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { DisambiguationTiebreak } from '@agent-device/contracts/interaction';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { matchesSelector } from './match.ts';
import type { Selector, SelectorChain } from './parse.ts';
import type {
  SelectorDiagnostics,
  SelectorDisambiguationDisclosure,
  SelectorMatchOptions,
  SelectorResolutionOptions,
} from './public-resolution-types.ts';

/**
 * The parser-side twin of the façade's `SelectorResolution`: identical except
 * that the winning alternative is the `Selector` node itself, which the façade
 * flattens to its `raw` text before any consumer sees it. Only the fields that
 * differ are restated; everything else is shared with
 * `public-resolution-types.ts`.
 */
export type AstSelectorResolution = {
  node: SnapshotNode;
  selector: Selector;
  selectorIndex: number;
  matches: number;
  diagnostics: SelectorDiagnostics[];
  disambiguation?: SelectorDisambiguationDisclosure;
};

/**
 * A resolution together with the matched-node domain the SAME pass decided it
 * over, so a caller that needs both stops re-deriving the second one.
 *
 * `matchedNodes` describes the winning alternative when `resolution` is
 * non-null. When no alternative resolved, it describes the first alternative
 * that matched anything — the set `listSelectorChainMatches` reports, computed
 * here by the pass that already visited those nodes.
 *
 * `firstMatch` is the SAME "first alternative that matched anything" domain
 * `listSelectorChainMatches` reports, but populated unconditionally — a
 * uniqueness row can resolve from a LATER alternative than the one it first
 * matched (uniqueness skips an ambiguous alternative to try the next one), so
 * `firstMatch` and `matchedNodes`/`resolution` can name different
 * alternatives. A caller whose contract is "the first thing that matched",
 * not "what resolution bound to" (#1970), reads this instead of paying a
 * second whole-tree scan for `listSelectorChainMatches`.
 */
export type AstSelectorChainResolutionDomain = {
  resolution: AstSelectorResolution | null;
  matchedNodes: SnapshotNode[];
  firstMatch: AstSelectorChainMatchList | null;
};

export function resolveSelectorChainDomain(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  options: SelectorResolutionOptions,
): AstSelectorChainResolutionDomain {
  const requireRect = options.requireRect ?? false;
  const requireUnique = options.requireUnique ?? true;
  const diagnostics: SelectorDiagnostics[] = [];
  let firstMatch: AstSelectorChainMatchList | null = null;
  for (const [i, selector] of chain.selectors.entries()) {
    const summary = analyzeSelectorMatches(nodes, selector, options.platform, requireRect);
    diagnostics.push({ selector: selector.raw, matches: summary.count });
    if (summary.count === 0 || !summary.firstNode) continue;
    firstMatch ??= { selector, selectorIndex: i, matchedNodes: summary.candidates };
    if (requireUnique && summary.count !== 1) {
      if (!options.disambiguateAmbiguous || !summary.disambiguated || !summary.tiebreak) continue;
      return {
        matchedNodes: summary.candidates,
        firstMatch,
        resolution: {
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
        },
      };
    }
    return {
      matchedNodes: summary.candidates,
      firstMatch,
      resolution: {
        node: summary.firstNode,
        selector,
        selectorIndex: i,
        matches: summary.count,
        diagnostics,
      },
    };
  }
  return { resolution: null, matchedNodes: firstMatch?.matchedNodes ?? [], firstMatch };
}

export function resolveSelectorChain(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  options: SelectorResolutionOptions,
): AstSelectorResolution | null {
  return resolveSelectorChainDomain(nodes, chain, options).resolution;
}

/** The parser-side twin of the façade's `SelectorChainMatchList`. */
export type AstSelectorChainMatchList = {
  selector: Selector;
  selectorIndex: number;
  matchedNodes: SnapshotNode[];
};

/**
 * ADR 0012 migration step 4: the raw matched-node list for whichever chain
 * alternative `resolveSelectorChain` would pick (first alternative with any
 * match, in order) — mirrors `analyzeSelectorMatches`'s alternate-selection
 * exactly, decoupled from uniqueness/disambiguation, so a replay-time
 * verifier can compute `matchCount` and the recorded-identity set over the
 * SAME domain resolution itself used, independent of whether resolution
 * could pick a unique winner.
 */
export function listSelectorChainMatches(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  options: SelectorMatchOptions,
): AstSelectorChainMatchList | null {
  const requireRect = options.requireRect ?? false;
  for (const [i, selector] of chain.selectors.entries()) {
    const matchedNodes = nodes.filter((node) => {
      if (requireRect && !node.rect) return false;
      return matchesSelector(node, selector, options.platform);
    });
    if (matchedNodes.length > 0) return { selector, selectorIndex: i, matchedNodes };
  }
  return null;
}

/**
 * A first-match lookup used by existence checks. No façade twin: the root
 * façade resolves through the policy interface only, so this shape reaches
 * consumers via the published `./ast` surface alone (#1630).
 */
export type AstSelectorChainMatch = {
  selectorIndex: number;
  selector: Selector;
  matches: number;
  diagnostics: SelectorDiagnostics[];
};

export function findSelectorChainMatch(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  options: SelectorMatchOptions,
): AstSelectorChainMatch | null {
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
  expression: string,
  diagnostics: SelectorDiagnostics[],
  options: { unique?: boolean },
): string {
  if (diagnostics.length === 0) {
    return `Selector did not match: ${expression}`;
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
  // Lazily built: only ambiguous matches pay for viewport inference, and both
  // maps are built once per alternative so N ambiguous candidates share one
  // whole-tree pass instead of the visibility resolver re-deriving the
  // viewport rects for each candidate it is asked about (#1970).
  const visibility = createSnapshotVisibility(nodes);
  const isVisible = visibility.isVisibleOnScreen;
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
