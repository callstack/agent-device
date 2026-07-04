import { definePathCoverage } from './coverage-manifest.ts';

export const DIRECT_IOS_SELECTOR_COVERAGE = definePathCoverage('direct-ios-selector', {
  offscreen:
    'direct-ios-selector offscreen: runner ELEMENT_OFFSCREEN falls back to the runtime refusal',
  responseConstruction:
    'direct-ios-selector responseConstruction: runner payload response carries the canonical selector field set',
  verifyEvidence:
    'direct-ios-selector verifyEvidence: --verify disables the direct path and returns runtime evidence',
});
