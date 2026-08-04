import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { DisambiguationTiebreak } from '@agent-device/contracts/interaction';
import type { ReplayDivergenceSuggestionBasis } from '@agent-device/contracts/divergence';
import { splitIsSelectorArgs, splitSelectorFromArgs } from './arguments.ts';
import { buildSelectorChainForNode } from './build.ts';
import { matchesSelector } from './match.ts';
import { tryParseSelectorChain } from './parse.ts';
import { listSelectorChainMatches, resolveSelectorChain } from './resolve.ts';

/**
 * Which selector-bearing positional grammar a replay action uses. `is` puts a
 * predicate beside the selector and so needs its own split; every other
 * command — `wait`, `click`, `fill`, a bare recorded token — carries the
 * selector as a plain leading positional and shares one rule. Two variants,
 * because there are two splits: naming each command's grammar separately would
 * advertise a distinction this module does not make.
 */
export type ReplaySelectorGrammar = 'is' | 'positional';

export type ReplaySelectorExpressionOutcome =
  | {
      readonly kind: 'expression';
      readonly expression: string;
      readonly rest: readonly string[];
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'not-applicable' };

export type ReplayRecordedTargetPolicy = Readonly<{
  readonly platform: Platform | PublicPlatform;
  readonly requireRect: boolean;
  readonly allowDisambiguation: boolean;
}>;

export type ReplayRecordedTargetDisambiguation = Readonly<{
  readonly tiebreak: DisambiguationTiebreak;
  readonly matchCount: number;
  readonly alternatives: readonly SnapshotNode[];
}>;

export type ReplayRecordedTargetResolved = Readonly<{
  readonly kind: 'resolved';
  readonly winner: SnapshotNode;
  readonly matchedNodes: readonly SnapshotNode[];
  readonly matchCount: number;
  readonly disambiguation?: ReplayRecordedTargetDisambiguation;
}>;

export type ReplayRecordedTargetUnresolved = Readonly<{
  readonly kind: 'unresolved';
  readonly reason: 'parse-invalid' | 'no-match' | 'ambiguous';
  readonly matchedNodes: readonly SnapshotNode[];
}>;

export type ReplayRecordedTargetResolution =
  | ReplayRecordedTargetResolved
  | ReplayRecordedTargetUnresolved;

export type ReplaySelectorCandidateAction = 'click' | 'fill' | 'get';

export type ReplaySelectorCandidateOptions = Readonly<{
  readonly action?: ReplaySelectorCandidateAction;
  readonly nodes?: readonly SnapshotNode[];
}>;

/** Resolve one selector expression against the same argument grammar as dispatch. */
export function readSelectorExpression(
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

/** Resolve a recorded target and return the winning node plus its same-alternative domain. */
export function resolveRecordedTarget(
  expression: string,
  nodes: SnapshotNode[],
  policy: ReplayRecordedTargetPolicy,
): ReplayRecordedTargetResolution {
  const chain = tryParseSelectorChain(expression);
  if (!chain) return { kind: 'unresolved', reason: 'parse-invalid', matchedNodes: [] };
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: policy.platform,
    requireRect: policy.requireRect,
    requireUnique: true,
    disambiguateAmbiguous: policy.allowDisambiguation,
  });
  if (resolved) {
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

/** Build the ordered replay/repair selector candidates for a captured node. */
export function buildSelectorCandidates(
  node: SnapshotNode,
  platform: Platform | PublicPlatform,
  options: ReplaySelectorCandidateOptions = {},
): readonly string[] {
  return buildSelectorChainForNode(node, platform, options);
}

export type ReplaySuggestionCandidateMatch = Readonly<{
  readonly node: SnapshotNode;
  readonly basis: ReplayDivergenceSuggestionBasis;
}>;

/** Resolve a divergence suggestion candidate and classify its winning selector basis. */
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

/** Read one stable label/text/id value for replay progress without exposing selector terms. */
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

function classifySuggestionBasis(selector: {
  terms: readonly { key: string }[];
}): ReplayDivergenceSuggestionBasis {
  const keys = new Set(selector.terms.map((term) => term.key));
  if (keys.has('id')) return 'id';
  const hasRole = keys.has('role');
  const hasLabelLike = keys.has('label') || keys.has('text');
  if (hasRole && hasLabelLike) return 'role-label';
  if (hasLabelLike || keys.has('value')) return 'label';
  return 'other';
}
