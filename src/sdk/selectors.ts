export type { SelectorChain } from '../selectors/parse.ts';
export type { SelectorDiagnostics } from '../selectors/index.ts';

export { isSelectorToken, parseSelectorChain, tryParseSelectorChain } from '../selectors/parse.ts';
export {
  findSelectorChainMatch,
  formatSelectorFailure,
  isNodeEditable,
  isNodeVisible,
  resolveSelectorChain,
} from '../selectors/index.ts';
