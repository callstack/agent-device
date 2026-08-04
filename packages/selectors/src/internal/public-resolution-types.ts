import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { DisambiguationTiebreak } from '@agent-device/contracts/interaction';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

/** One per-alternative diagnostic returned by selector resolution. */
export type SelectorDiagnostics = {
  selector: string;
  matches: number;
};

/** The disclosure for an ambiguous selector that was resolved by the heuristic. */
export type SelectorDisambiguationDisclosure = {
  matchCount: number;
  tiebreak: DisambiguationTiebreak;
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

/** Shared options used by selector operations. */
export type SelectorResolutionOptions = {
  platform: Platform | PublicPlatform;
  requireRect?: boolean;
  requireUnique?: boolean;
  disambiguateAmbiguous?: boolean;
};
