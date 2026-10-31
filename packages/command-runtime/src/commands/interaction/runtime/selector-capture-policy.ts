import type { IsPredicate } from '@agent-device/selectors';

export type SelectorCapturePolicy = {
  includeRects: boolean;
  interactiveOnly: boolean;
};

/**
 * What a selector read needs from its capture. Only `is` narrows this: the two
 * geometry predicates need rects, and every other selector read — including
 * every `find`, `wait`, and bare-selector lookup — takes the same default.
 */
export function deriveSelectorCapturePolicy(predicate?: IsPredicate): SelectorCapturePolicy {
  return {
    includeRects: predicate === 'visible' || predicate === 'hidden',
    interactiveOnly: false,
  };
}
