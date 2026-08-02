import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetResolution,
  ReplaySelectorCandidateOptions,
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySelectorPort,
} from '@agent-device/ad-replay';
import { matchesSelector } from '../selectors/match.ts';
import {
  buildSelectorChainForNode,
  listSelectorChainMatches,
  resolveSelectorChain,
  splitIsSelectorArgs,
  splitSelectorFromArgs,
  tryParseSelectorChain,
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
