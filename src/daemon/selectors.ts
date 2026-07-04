export type { Selector, SelectorChain } from './selectors-parse.ts';
export type { SelectorDiagnostics, SelectorResolution } from './selectors-resolve.ts';

export {
  parseSelectorChain,
  tryParseSelectorChain,
  splitSelectorFromArgs,
  splitIsSelectorArgs,
} from './selectors-parse.ts';

export { isNodeVisible, isNodeEditable } from './selectors-match.ts';

export {
  resolveSelectorChain,
  findSelectorChainMatch,
  formatSelectorFailure,
  selectorFailureHint,
  STALE_REF_HINT,
} from './selectors-resolve.ts';

export { buildSelectorChainForNode } from '../utils/selector-build.ts';
