import type { SelectorResolutionOptions } from './public-resolution-types.ts';

/**
 * The per-caller selector-resolution policy matrix (#1630): every native
 * consumer of "resolve a selector against the screen" declares its ambiguity
 * contract here instead of passing `requireUnique`/`disambiguateAmbiguous`
 * literals at the call site. The engine stays policy-neutral; which row a
 * caller consumes IS the caller's documented contract, and changing a row is
 * a reviewable one-line policy change instead of a multi-file literal hunt.
 *
 * Ambiguity kinds:
 * - `disambiguate` — unique match required, but the engine's visible→deepest→
 *   smallest-area tiebreak may pick a winner from an ambiguous set (`get text`).
 * - `fail-closed` — unique match required, ties reject (by design: `is`
 *   predicates and `get attrs` must never guess).
 * - `first-match` — any match count accepted, first wins (existence reads and
 *   the wait loop, where presence is the question).
 * - `reject-candidates` — multiple matches stay visible to the caller, which
 *   either proves structural equivalence (acting targets) or rejects with a
 *   candidate list (#1625's mutating-find contract). It is not reducible to
 *   engine knobs, so `selectorResolutionKnobs` rejects it at the type level.
 *
 * Scope, deliberately narrow: this matrix declares the **ambiguity contract
 * and the rect requirement**, and nothing else. Both are consumed by
 * `resolveSelectorChainWithPolicy` — the one door native callers have, since
 * the package façade exports no knob-taking resolver — and pinned behaviorally
 * in resolution-policy-parity.test.ts, so a row that stops matching its
 * documented semantics fails a test.
 *
 * The surrounding pipeline stages — occlusion, the off-screen guard,
 * hittable-ancestor promotion, and the wait poll budget — still live in the
 * callers and are NOT declared here. An earlier revision listed them as
 * columns; nothing consumed them, so they were unverifiable claims that read
 * as truth while being free to drift (#1649 review). Routing them into typed
 * behavior is tracked in #1656.
 */

export type KnobBackedSelectorAmbiguity = 'disambiguate' | 'fail-closed' | 'first-match';
export type SelectorAmbiguityPolicy = KnobBackedSelectorAmbiguity | 'reject-candidates';

export type SelectorResolutionPolicy = {
  ambiguity: SelectorAmbiguityPolicy;
  /** Only nodes carrying a rect participate (acting paths need a tap point). */
  requireRect: boolean;
};

export const SELECTOR_RESOLUTION_POLICIES = {
  /** Runtime interaction targets; the caller may collapse one equivalent wrapper chain. */
  act: {
    ambiguity: 'reject-candidates',
    requireRect: true,
  },
  /** The post-miss diagnosis probe deciding "no match" vs "matched but covered". */
  actCoveredDiagnosis: {
    ambiguity: 'first-match',
    requireRect: true,
  },
  /** `get text` — reads through the same tiebreak acting uses. */
  readText: {
    ambiguity: 'disambiguate',
    requireRect: false,
  },
  /** `is` non-exists predicates and `get attrs` — ties reject, never guess. */
  readUnique: {
    ambiguity: 'fail-closed',
    requireRect: false,
  },
  /** `exists` and find's read-only actions — presence is the question. */
  readAny: {
    ambiguity: 'first-match',
    requireRect: false,
  },
  /** `wait` — first match per poll, under the wait budget. */
  wait: {
    ambiguity: 'first-match',
    requireRect: false,
  },
  /** Mutating `find` (#1625): candidates reject unless explicitly narrowed. */
  findAct: {
    ambiguity: 'reject-candidates',
    requireRect: true,
  },
} as const satisfies Record<string, SelectorResolutionPolicy>;

/**
 * The engine knobs a knob-backed policy row stands for, and the only place in
 * the repo that names `requireUnique`/`disambiguateAmbiguous` (#1630): the
 * façade exports no resolver that accepts them, so a caller cannot restate an
 * ambiguity contract as knobs even by accident. `reject-candidates` rows are
 * rejected at the type level — that contract is enforced by caller
 * classification, not by these knobs.
 */
export function selectorResolutionKnobs(
  policy: SelectorResolutionPolicy & { ambiguity: KnobBackedSelectorAmbiguity },
): Pick<SelectorResolutionOptions, 'requireRect' | 'requireUnique' | 'disambiguateAmbiguous'> {
  if (policy.ambiguity === 'first-match') {
    return { requireRect: policy.requireRect, requireUnique: false };
  }
  return {
    requireRect: policy.requireRect,
    requireUnique: true,
    disambiguateAmbiguous: policy.ambiguity === 'disambiguate',
  };
}
