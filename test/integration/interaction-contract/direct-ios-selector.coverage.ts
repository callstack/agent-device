import { definePathCoverage } from './coverage-manifest.ts';

export const DIRECT_IOS_SELECTOR_COVERAGE = definePathCoverage('direct-ios-selector', {
  errorTaxonomy:
    'direct-ios-selector errorTaxonomy: runner ELEMENT_NOT_FOUND falls back to runtime no-match diagnostics and hint',
  nonHittable:
    'direct-ios-selector nonHittable: runner ELEMENT_NOT_FOUND on a non-hittable target falls back to an annotated coordinate tap',
  occlusion:
    'direct-ios-selector occlusion: runner ELEMENT_NOT_FOUND on a covered target falls back to the runtime covered refusal',
  offscreen:
    'direct-ios-selector offscreen: runner ELEMENT_OFFSCREEN falls back to the runtime refusal',
  responseConstruction:
    'direct-ios-selector responseConstruction: runner payload response carries the canonical selector field set',
  verifyEvidence:
    'direct-ios-selector verifyEvidence: --verify disables the direct path and returns runtime evidence',
  settleObservation:
    'direct-ios-selector settleObservation: --settle disables the direct path and returns the runtime settled diff',
  resolutionDisclosure:
    'direct-ios-selector resolutionDisclosure: the XCTest fast path discloses the explicit not-observed shape',
});
