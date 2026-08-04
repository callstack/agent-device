import type { IsPredicate } from '@agent-device/selectors';

export type SelectorCapturePolicyInput = {
  predicate?: IsPredicate;
  selectorExpression?: string | null;
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
