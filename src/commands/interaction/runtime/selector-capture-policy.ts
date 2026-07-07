import type { SelectorChain } from '../../../utils/selectors-parse.ts';
import type { IsPredicate } from '../../../utils/selector-is-predicates.ts';

export type SelectorCapturePolicyInput = {
  predicate?: IsPredicate;
  selectorChain?: SelectorChain | null;
};

export type SelectorCapturePolicy = {
  includeRects: boolean;
  interactiveOnly: boolean;
};

export function deriveSelectorCapturePolicy(
  input: SelectorCapturePolicyInput,
): SelectorCapturePolicy {
  const includeRects = predicateNeedsRects(input.predicate);
  return {
    includeRects,
    interactiveOnly:
      input.predicate === 'focused' ||
      (input.selectorChain ? selectorChainReadsFocus(input.selectorChain) : false),
  };
}

function selectorChainReadsFocus(chain: SelectorChain): boolean {
  return chain.selectors.some((selector) => selector.terms.some((term) => term.key === 'focused'));
}

function predicateNeedsRects(predicate: IsPredicate | undefined): boolean {
  return predicate === 'visible' || predicate === 'hidden';
}
