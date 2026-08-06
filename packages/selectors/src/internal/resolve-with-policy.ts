import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { SelectorChain } from './parse.ts';
import type { SelectorMatchOptions } from './public-resolution-types.ts';
import {
  listSelectorChainMatches,
  resolveSelectorChain,
  type AstSelectorResolution,
} from './resolve.ts';
import type { SelectorResolutionPolicy } from './resolution-policy.ts';

/**
 * The one policy-driven resolution entry every native caller routes through
 * (#1630). A caller passes the policy row that IS its documented contract;
 * this decides what "resolved" means for that row, so ambiguity semantics
 * live in the matrix rather than in each caller's local branching.
 *
 * The outcome is a discriminated union rather than a nullable node, because
 * the rows genuinely disagree about what to do with several matches:
 * `disambiguate` and `fail-closed` want one winner or nothing, `first-match`
 * wants the head of the list, and `reject-candidates` needs the whole
 * candidate set to refuse with (or to narrow, when the caller was given an
 * explicit index). Collapsing those into "node | null" is what previously
 * forced every caller to re-derive its own contract inline.
 */

export type PolicyResolutionOutcome =
  /** No selector alternative matched anything. */
  | { kind: 'none' }
  /** Exactly the node this policy authorizes acting on. */
  | { kind: 'resolved'; resolution: AstSelectorResolution }
  /**
   * Several matches and the policy refuses to choose. `fail-closed` returns
   * this instead of guessing; `reject-candidates` returns it so the caller
   * can narrow explicitly or surface the candidate list.
   */
  | {
      kind: 'ambiguous';
      selector: string;
      selectorIndex: number;
      matchedNodes: SnapshotState['nodes'];
    };

export function resolveSelectorChainWithPolicy(
  nodes: SnapshotState['nodes'],
  chain: SelectorChain,
  policy: SelectorResolutionPolicy,
  options: SelectorMatchOptions,
): PolicyResolutionOutcome {
  const matchOptions = { ...options, requireRect: policy.requireRect };

  if (policy.ambiguity === 'reject-candidates') {
    const list = listSelectorChainMatches(nodes, chain, matchOptions);
    if (!list || list.matchedNodes.length === 0) return { kind: 'none' };
    if (list.matchedNodes.length > 1) {
      return {
        kind: 'ambiguous',
        selector: list.selector.raw,
        selectorIndex: list.selectorIndex,
        matchedNodes: list.matchedNodes,
      };
    }
    return resolvedFromList(list);
  }

  if (policy.ambiguity === 'first-match') {
    const list = listSelectorChainMatches(nodes, chain, matchOptions);
    if (!list || list.matchedNodes.length === 0) return { kind: 'none' };
    return resolvedFromList(list);
  }

  const resolution = resolveSelectorChain(nodes, chain, {
    ...matchOptions,
    requireUnique: true,
    disambiguateAmbiguous: policy.ambiguity === 'disambiguate',
  });
  if (resolution) return { kind: 'resolved', resolution };

  // Distinguish "nothing matched" from "matched but this policy will not
  // choose" — a fail-closed caller must report ambiguity, not absence.
  const list = listSelectorChainMatches(nodes, chain, matchOptions);
  if (!list || list.matchedNodes.length === 0) return { kind: 'none' };
  return {
    kind: 'ambiguous',
    selector: list.selector.raw,
    selectorIndex: list.selectorIndex,
    matchedNodes: list.matchedNodes,
  };
}

function resolvedFromList(
  list: NonNullable<ReturnType<typeof listSelectorChainMatches>>,
): PolicyResolutionOutcome {
  const node = list.matchedNodes[0];
  if (!node) return { kind: 'none' };
  return {
    kind: 'resolved',
    resolution: {
      node,
      selector: list.selector,
      selectorIndex: list.selectorIndex,
      matches: list.matchedNodes.length,
      diagnostics: [{ selector: list.selector.raw, matches: list.matchedNodes.length }],
    },
  };
}
