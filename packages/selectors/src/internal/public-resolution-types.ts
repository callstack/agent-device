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

/** The first matching selector alternative and its complete matched-node domain. */
export type SelectorChainMatchList = {
  selector: string;
  selectorIndex: number;
  matchedNodes: SnapshotNode[];
};

/** A first-match lookup used by existence checks. */
export type SelectorChainMatch = {
  selectorIndex: number;
  selector: string;
  matches: number;
  diagnostics: SelectorDiagnostics[];
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
