import type { IsPredicate } from '../../../utils/selector-is-predicates.ts';
import type { SelectorChain } from '../../../utils/selectors-parse.ts';

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
    interactiveOnly: false,
  };
}

function predicateNeedsRects(predicate: IsPredicate | undefined): boolean {
  return predicate === 'visible' || predicate === 'hidden';
}
