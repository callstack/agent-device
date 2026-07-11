export type { Selector, SelectorChain } from './arguments.ts';
export type { SelectorDiagnostics, SelectorResolution, SelectorChainMatchList } from './resolve.ts';

export {
  parseSelectorChain,
  tryParseSelectorChain,
  splitSelectorFromArgs,
  splitIsSelectorArgs,
} from './arguments.ts';

export { isNodeVisible, isNodeEditable } from './match.ts';

export {
  resolveSelectorChain,
  listSelectorChainMatches,
  findSelectorChainMatch,
  formatSelectorFailure,
  selectorFailureHint,
  STALE_REF_HINT,
} from './resolve.ts';

export { buildSelectorChainForNode } from './build.ts';
