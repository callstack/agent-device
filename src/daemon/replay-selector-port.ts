import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetResolution,
  ReplaySelectorCandidateOptions,
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySelectorPort,
} from '@agent-device/ad-replay';
import type { ReplayDivergenceSuggestionBasis } from '@agent-device/contracts/divergence';
import { matchesSelector } from '../selectors/match.ts';
import {
  buildSelectorChainForNode,
  listSelectorChainMatches,
  resolveSelectorChain,
  splitIsSelectorArgs,
  splitSelectorFromArgs,
  tryParseSelectorChain,
  type Selector,
} from '../selectors/index.ts';

/**
 * #1478 P5 stage B: the production `ReplaySelectorPort` adapter. Delegates to
 * `src/selectors` internals, composing parse/resolve/list-matches/match
 * exactly as `session-replay-target-classification.ts`'s
 * `resolveSelectorTargetMatches` does today — that composition (and the
 * "same selector alternative" winner+domain invariant it protects) lives
 * HERE now; handlers keep calling their existing direct imports until stage C
 * migrates them onto this port.
 */
export function createDaemonReplaySelectorPort(): ReplaySelectorPort {
  return {
    readSelectorExpression: readSelectorExpression,
    resolveRecordedTarget: resolveRecordedTarget,
    buildSelectorCandidates: buildSelectorCandidates,
  };
}

/**
 * `is`'s grammar goes through `splitIsSelectorArgs` (predicate-first or
 * selector-first, per `session-replay-target-token.ts`'s eligible-token
 * extraction); `wait`/`ordinary` share the same underlying
 * `splitSelectorFromArgs` primitive `src/core/wait-positionals.ts` and
 * `src/core/interaction-positionals.ts` already use for their own
 * selector-bearing positional forms. Either way, a syntactically-found
 * expression is validated with `tryParseSelectorChain` before being handed
 * back — callers must not need a second parse-validity check before calling
 * `resolveRecordedTarget` (`selector-port-contract.test.ts` cell 1).
 */
function readSelectorExpression(
  grammar: ReplaySelectorGrammar,
  positionals: readonly string[],
): ReplaySelectorExpressionOutcome {
  const split =
    grammar === 'is'
      ? splitIsSelectorArgs([...positionals]).split
      : splitSelectorFromArgs([...positionals]);
  if (!split) return { kind: 'not-applicable' };
  if (!tryParseSelectorChain(split.selectorExpression)) return { kind: 'invalid' };
  return { kind: 'expression', expression: split.selectorExpression, rest: split.rest };
}

function resolveRecordedTarget(
  expression: string,
  nodes: SnapshotNode[],
  policy: ReplayRecordedTargetPolicy,
): ReplayRecordedTargetResolution {
  const chain = tryParseSelectorChain(expression);
  if (!chain) {
    return { kind: 'unresolved', reason: 'parse-invalid', matchedNodes: [] };
  }
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: policy.platform,
    requireRect: policy.requireRect,
    requireUnique: true,
    disambiguateAmbiguous: policy.allowDisambiguation,
  });
  if (resolved) {
    // The matched-node domain must come from the SAME chain alternative the
    // winner resolved through, not the first alternative with any match at
    // all — an earlier ambiguous/tied alternative can be skipped in favor of
    // a later resolvable one (the amendment's same-alternative invariant).
    const matchedNodes = nodes.filter((node) => {
      if (policy.requireRect && !node.rect) return false;
      return matchesSelector(node, resolved.selector, policy.platform);
    });
    return {
      kind: 'resolved',
      winner: resolved.node,
      matchedNodes,
      matchCount: matchedNodes.length,
      ...(resolved.disambiguation
        ? {
            disambiguation: {
              tiebreak: resolved.disambiguation.tiebreak,
              matchCount: resolved.disambiguation.matchCount,
              alternatives: resolved.disambiguation.alternatives,
            },
          }
        : {}),
    };
  }
  // No alternative produced a dispatch winner (e.g. ambiguity without
  // disambiguation). Keep the established diagnostic domain — the first
  // alternative with any match — so callers can still report a matchCount,
  // without inventing a winner.
  const matchList = listSelectorChainMatches(nodes, chain, {
    platform: policy.platform,
    requireRect: policy.requireRect,
  });
  const matchedNodes = matchList?.matchedNodes ?? [];
  return {
    kind: 'unresolved',
    reason: matchedNodes.length > 0 ? 'ambiguous' : 'no-match',
    matchedNodes,
  };
}

function buildSelectorCandidates(
  node: SnapshotNode,
  platform: ReplayRecordedTargetPolicy['platform'],
  options: ReplaySelectorCandidateOptions = {},
): readonly string[] {
  return buildSelectorChainForNode(node, platform, options);
}

// ---------------------------------------------------------------------------
// #1478 P5 stage C: daemon-only siblings to `ReplaySelectorPort`. Both need
// the private `Selector` AST of a resolved chain alternative — term keys for
// `resolveReplaySuggestionCandidate`'s basis classification, term values for
// `readReplaySelectorDisplayValue`'s progress-step label — which the port
// deliberately never exposes (the amendment's Selector/SelectorChain/
// SelectorTerm rejection). Neither is part of the swappable 3-operation
// contract (packages/ad-replay's in-memory adapter has no need for them), so
// they stay here as plain functions the daemon handlers import directly,
// rather than being threaded through a `ReplaySelectorPort` instance.
// ---------------------------------------------------------------------------

export type ReplaySuggestionCandidateMatch = Readonly<{
  readonly node: SnapshotNode;
  readonly basis: ReplayDivergenceSuggestionBasis;
}>;

/**
 * Resolves ONE divergence-suggestion candidate string against the current
 * tree and classifies which selector fields (id / role+label / label / other)
 * the WINNING chain alternative used — lifted verbatim from
 * `session-replay-divergence.ts`'s old `resolveSuggestionCandidate` +
 * `classifySuggestionBasis` composition.
 */
export function resolveReplaySuggestionCandidate(
  candidate: string,
  nodes: SnapshotNode[],
  policy: ReplayRecordedTargetPolicy,
): ReplaySuggestionCandidateMatch | undefined {
  const chain = tryParseSelectorChain(candidate);
  if (!chain) return undefined;
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: policy.platform,
    requireRect: policy.requireRect,
    requireUnique: true,
    disambiguateAmbiguous: policy.allowDisambiguation,
  });
  if (!resolved) return undefined;
  return { node: resolved.node, basis: classifySuggestionBasis(resolved.selector) };
}

function classifySuggestionBasis(selector: Selector): ReplayDivergenceSuggestionBasis {
  const keys = new Set(selector.terms.map((term) => term.key));
  if (keys.has('id')) return 'id';
  const hasRole = keys.has('role');
  const hasLabelLike = keys.has('label') || keys.has('text');
  if (hasRole && hasLabelLike) return 'role-label';
  if (hasLabelLike || keys.has('value')) return 'label';
  return 'other';
}

/**
 * A replay-test progress step's display `value`: the recorded selector's
 * label/text/id term value when every alternative agrees on ONE value, else
 * `undefined` — lifted verbatim from `session-replay-runtime.ts`'s old
 * `readSelectorDisplayValue`.
 */
export function readReplaySelectorDisplayValue(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const parsed = tryParseSelectorChain(selector);
  if (!parsed) return undefined;
  const values = parsed.selectors.flatMap((entry) =>
    entry.terms.flatMap((term) =>
      (term.key === 'label' || term.key === 'text' || term.key === 'id') &&
      typeof term.value === 'string'
        ? [term.value]
        : [],
    ),
  );
  if (values.length === 0) return undefined;
  const first = values[0];
  return first && values.every((value) => value === first) ? first : undefined;
}
