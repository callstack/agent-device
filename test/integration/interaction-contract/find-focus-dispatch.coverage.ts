import { definePathCoverage } from './coverage-manifest.ts';

export const FIND_FOCUS_DISPATCH_COVERAGE = definePathCoverage('find-focus-dispatch', {
  disambiguation:
    'find-focus-dispatch disambiguation: two matches refuse with bounded candidates unless --first narrows',
  occlusion: 'find-focus-dispatch occlusion: a covered match refuses to be focused',
  keyboardOcclusion: [
    'find-focus-dispatch keyboardOcclusion: a focus match behind the visible keyboard is refused with tap_keyboard_occludes_target',
    'find-focus-dispatch keyboardOcclusion: the same match above the keyboard band focuses',
  ],
  responseConstruction:
    'find-focus-dispatch responseConstruction: find focus returns the shared point-focus payload',
  errorTaxonomy:
    'find-focus-dispatch errorTaxonomy: an unmatched find focus fails with find locator diagnostics',
});
