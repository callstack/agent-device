export type { SelectorChain } from '../utils/selectors-parse.ts';
export type { SelectorDiagnostics } from '../daemon/selectors.ts';

export {
  isSelectorToken,
  parseSelectorChain,
  tryParseSelectorChain,
} from '../utils/selectors-parse.ts';
export {
  findSelectorChainMatch,
  formatSelectorFailure,
  isNodeEditable,
  isNodeVisible,
  resolveSelectorChain,
} from '../daemon/selectors.ts';
