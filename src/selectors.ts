export type { Selector, SelectorChain } from './utils/selectors-parse.ts';
export type { SelectorDiagnostics, SelectorResolution } from './daemon/selectors.ts';
export type { SnapshotNode } from './kernel/snapshot.ts';

export {
  isSelectorToken,
  parseSelectorChain,
  tryParseSelectorChain,
} from './utils/selectors-parse.ts';
export {
  findSelectorChainMatch,
  formatSelectorFailure,
  isNodeEditable,
  isNodeVisible,
  resolveSelectorChain,
} from './daemon/selectors.ts';
