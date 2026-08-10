import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { DisambiguationTiebreak } from '@agent-device/contracts/interaction';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

/** One per-alternative diagnostic returned by selector resolution. */
export type SelectorDiagnostics = {
  selector: string;
  matches: number;
};

/**
 * The disclosure for an ambiguous selector that was resolved by the heuristic;
 * present only when the heuristic picked among N>1 matches (ADR 0012).
 */
export type SelectorDisambiguationDisclosure = {
  matchCount: number;
  tiebreak: DisambiguationTiebreak;
  /** Every losing matched node, document order, uncapped (response layer caps). */
  alternatives: SnapshotNode[];
};

/** String-only resolution result; the parser representation remains package-private. */
export type SelectorResolution = {
  node: SnapshotNode;
  selector: string;
  selectorIndex: number;
  matches: number;
  diagnostics: SelectorDiagnostics[];
  disambiguation?: SelectorDisambiguationDisclosure;
};

/**
 * The façade twin of the parser-side `AstPolicyResolutionOutcome`: identical
 * except that the winning alternative is its raw selector text rather than the
 * `Selector` node, the same flattening `SelectorResolution` applies to
 * `AstSelectorResolution`.
 *
 * It exists as a separate declaration for the same reason that pair does
 * (#1589): the parser representation is package-private, and a nested return
 * type is a leak the façade's named-export gate cannot see — it filters export
 * *names*, so an `AstSelectorResolution` reached indirectly through
 * `outcome.resolution` would reopen the boundary silently.
 */
export type PolicyResolutionOutcome =
  /** No selector alternative matched anything. */
  | { kind: 'none' }
  /**
   * The node this policy authorizes acting on, plus the candidate set of the
   * first matching alternative. Callers that verify identity across candidates
   * (wait's #1349 landmark check) need the whole set — a policy that picks one
   * winner must not throw the rest away, or a first impostor would hide a
   * later genuine match. Those callers use `first-match` rows, where the two
   * fields describe the same alternative by construction; a uniqueness row can
   * resolve from a LATER alternative, so pair `matchedNodes` with
   * `resolution.selector` before reading them as one set.
   */
  | { kind: 'resolved'; resolution: SelectorResolution; matchedNodes: SnapshotNode[] }
  /**
   * Several matches and the policy refuses to choose. `fail-closed` returns
   * this instead of guessing; `reject-candidates` returns it so the caller can
   * narrow explicitly or surface the candidate list.
   */
  | { kind: 'ambiguous'; selector: string; selectorIndex: number; matchedNodes: SnapshotNode[] };

/** The first matching selector alternative and its complete matched-node domain. */
export type SelectorChainMatchList = {
  selector: string;
  selectorIndex: number;
  matchedNodes: SnapshotNode[];
};

/**
 * The options every selector lookup takes. Stated once here rather than inline
 * per function so a façade wrapper and the parser-side function it forwards to
 * cannot drift apart.
 */
export type SelectorMatchOptions = {
  platform: Platform | PublicPlatform;
  requireRect?: boolean;
};

/** {@link SelectorMatchOptions} plus the uniqueness policy resolution adds. */
export type SelectorResolutionOptions = SelectorMatchOptions & {
  requireUnique?: boolean;
  disambiguateAmbiguous?: boolean;
};
