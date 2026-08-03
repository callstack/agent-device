/**
 * #1478 P5 stage B: the `ReplaySelectorPort` — the replay-oriented internal
 * selector capability approved by the P5 amendment (issue comment
 * 5156017698). Exactly three operations, none of which ever trades in
 * `Selector`/`SelectorChain`/`SelectorTerm`: those AST types stay private to
 * the root `src/selectors` implementation. This port's signatures traffic
 * only in strings, kernel snapshot/device types, and the tagged result unions
 * below, so `packages/ad-replay` never needs the selector grammar hoisted
 * into it (the amendment's explicit rejection of a "seven-function mirror").
 *
 * Two adapters implement this port:
 *  - the production adapter (`src/daemon/replay-selector-port.ts`), which
 *    delegates to `src/selectors` and composes parse/resolve/list-matches/
 *    match exactly as `session-replay-target-classification.ts` does today;
 *  - a deterministic in-memory adapter
 *    (`src/__tests__/test-utils/in-memory-replay-selector-port.ts` — root,
 *    not package-internal: R11 forbids a workspace package from reaching
 *    back into root `src/`, so once this adapter's only consumer turned out
 *    to be a root test, it moved alongside its caller) for the package's own
 *    contract suite (`src/daemon/__tests__/replay-selector-port-contract.test.ts`).
 *
 * Stage B built the port and both adapters. Handlers now reach it through
 * `@agent-device/ad-replay`'s exported `ReplaySelectorPort` type.
 */

import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { DisambiguationTiebreak } from '@agent-device/contracts/interaction';

// ---------------------------------------------------------------------------
// Operation 1: readSelectorExpression — the shared `is`/`wait`/ordinary
// selector-argument grammar. Mirrors today's `splitIsSelectorArgs` (the
// `is`-command call site this stage abstracts,
// `session-replay-target-token.ts`) and the shared `splitSelectorFromArgs`
// primitive `wait`/ordinary target grammar already uses elsewhere in the
// codebase (`src/core/wait-positionals.ts`, `src/core/interaction-positionals.ts`).
// ---------------------------------------------------------------------------

/** Which positional grammar a command's selector-bearing arguments follow. */
export type ReplaySelectorGrammar =
  /** `is <predicate> <selector> [expected]` — predicate-first or selector-first. */
  | 'is'
  /** `wait <selector> [timeoutMs]` — caller has already stripped a trailing timeout token. */
  | 'wait'
  /** Plain positional selector arguments (`click`/`fill`/`get`-shaped). */
  | 'ordinary';

export type ReplaySelectorExpressionOutcome =
  /** A selector-shaped expression was extracted and parses. */
  | {
      readonly kind: 'expression';
      readonly expression: string;
      /** Trailing tokens after the selector (e.g. `is text`'s expected value). */
      readonly rest: readonly string[];
    }
  /**
   * A selector-shaped prefix was found but it does not parse — callers must
   * check this BEFORE ever calling `resolveRecordedTarget`, which assumes a
   * well-formed expression (see `selector-port-contract.test.ts` cell 1).
   */
  | { readonly kind: 'invalid' }
  /** This grammar found no selector-shaped token at all (not an error). */
  | { readonly kind: 'not-applicable' };

// ---------------------------------------------------------------------------
// Operation 2: resolveRecordedTarget — selector string + snapshot nodes +
// platform + resolution policy in; tagged winner/domain out. Internally
// composes parse (`tryParseSelectorChain`) / resolve (`resolveSelectorChain`)
// / list-matches (`listSelectorChainMatches`) / match (`matchesSelector`)
// exactly as `session-replay-target-classification.ts`'s
// `resolveSelectorTargetMatches` does today, protecting the "same selector
// alternative" invariant between the winner and the matched-node domain.
// ---------------------------------------------------------------------------

export type ReplayRecordedTargetPolicy = Readonly<{
  readonly platform: Platform | PublicPlatform;
  /** Excludes an otherwise-matching node with no usable rect (cell 4). */
  readonly requireRect: boolean;
  /** Lets the deepest/smallest-then-visible heuristic pick among ties (cell 3). */
  readonly allowDisambiguation: boolean;
}>;

/** Present only when the heuristic picked among N>1 matches for the winning alternative. */
export type ReplayRecordedTargetDisambiguation = Readonly<{
  readonly tiebreak: DisambiguationTiebreak;
  readonly matchCount: number;
  /** Every losing matched node from the SAME alternative, document order. */
  readonly alternatives: readonly SnapshotNode[];
}>;

export type ReplayRecordedTargetResolved = Readonly<{
  readonly kind: 'resolved';
  readonly winner: SnapshotNode;
  /**
   * The matched-node domain from the SAME chain alternative the winner was
   * resolved through — never a different, earlier-tried alternative (the
   * amendment's "same domain as dispatch" invariant; see
   * `session-replay-target-classification-port.test.ts` cell 5).
   */
  readonly matchedNodes: readonly SnapshotNode[];
  readonly matchCount: number;
  readonly disambiguation?: ReplayRecordedTargetDisambiguation;
}>;

export type ReplayRecordedTargetUnresolved = Readonly<{
  readonly kind: 'unresolved';
  /**
   * `parse-invalid`: the expression does not parse at all (no matched-node
   * domain exists). `no-match`: it parses, but no alternative matches
   * anything. `ambiguous`: it parses and at least one alternative has
   * matches, but resolution could not pick a unique/disambiguated winner.
   */
  readonly reason: 'parse-invalid' | 'no-match' | 'ambiguous';
  /** Best-available diagnostic domain; always empty for `parse-invalid`. */
  readonly matchedNodes: readonly SnapshotNode[];
}>;

export type ReplayRecordedTargetResolution =
  | ReplayRecordedTargetResolved
  | ReplayRecordedTargetUnresolved;

// ---------------------------------------------------------------------------
// Operation 3: buildSelectorCandidates — replay repair/divergence suggestions
// via the existing root selector-chain builder (`buildSelectorChainForNode`).
// Mirrors its signature: a resolved node in, a priority-ordered list of
// candidate selector-expression strings out (id, then role+label, then
// label, then value, then text — see
// `session-replay-divergence-suggestion-port.test.ts` cell 8).
// ---------------------------------------------------------------------------

export type ReplaySelectorCandidateAction = 'click' | 'fill' | 'get';

export type ReplaySelectorCandidateOptions = Readonly<{
  readonly action?: ReplaySelectorCandidateAction;
  /** The record-time tree `node` came from, for #1269 non-unique-id demotion. */
  readonly nodes?: readonly SnapshotNode[];
}>;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type ReplaySelectorPort = Readonly<{
  readSelectorExpression(
    grammar: ReplaySelectorGrammar,
    positionals: readonly string[],
  ): ReplaySelectorExpressionOutcome;

  resolveRecordedTarget(
    expression: string,
    nodes: SnapshotNode[],
    policy: ReplayRecordedTargetPolicy,
  ): ReplayRecordedTargetResolution;

  buildSelectorCandidates(
    node: SnapshotNode,
    platform: Platform | PublicPlatform,
    options?: ReplaySelectorCandidateOptions,
  ): readonly string[];
}>;
