// The published selector AST surface, and the ONLY way the parser
// representation leaves this package.
//
// `./index.ts` is string-in/string-out on purpose: every in-repo consumer
// names selectors as text, so the AST has no business crossing that façade,
// and `package-boundaries.test.ts` asserts it does not. But `agent-device/selectors`
// has been a public subpath since before the engine moved in here, and it
// ships the AST — `parseSelectorChain` returning a `SelectorChain` IS the
// published contract. Removing it is a breaking change for consumers who
// parse and match selectors against a snapshot themselves.
//
// So the AST stays exported, through one named subpath instead of being
// reachable from anywhere: `src/sdk/selectors.ts` is its only consumer, and
// `facade-symbols.ts` pins this list to exactly what v0.20.5 shipped. Widening
// it means widening the public package, and the gate makes that a deliberate
// edit rather than a side effect.
import type { SelectorChain } from './internal/parse.ts';
import { formatSelectorFailure as formatSelectorFailureFromText } from './internal/resolve.ts';
import type { SelectorDiagnostics } from './internal/public-resolution-types.ts';

export type { SelectorChain } from './internal/parse.ts';
export type { SelectorDiagnostics } from './internal/public-resolution-types.ts';

export { isSelectorToken, parseSelectorChain, tryParseSelectorChain } from './internal/parse.ts';
export { findSelectorChainMatch, resolveSelectorChain } from './internal/resolve.ts';
export { isNodeEditable, isNodeVisible } from './internal/node.ts';

/**
 * The published signature takes a parsed chain or the raw text it came from;
 * the engine only ever needs the text. Kept here rather than widening
 * `internal/resolve.ts` back to a union, so the compatibility obligation sits
 * at the boundary that owes it.
 */
export function formatSelectorFailure(
  chain: SelectorChain | string,
  diagnostics: SelectorDiagnostics[],
  options: { unique?: boolean },
): string {
  return formatSelectorFailureFromText(
    typeof chain === 'string' ? chain : chain.raw,
    diagnostics,
    options,
  );
}
