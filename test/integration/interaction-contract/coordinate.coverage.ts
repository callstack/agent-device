import { definePathCoverage } from './coverage-manifest.ts';

export const COORDINATE_COVERAGE = definePathCoverage('coordinate', {
  offscreen: 'coordinate offscreen: out-of-viewport point is forwarded with a viewport warning',
  responseConstruction:
    'coordinate responseConstruction: daemon press x y response carries the canonical point field set',
  verifyEvidence:
    'coordinate verifyEvidence: point click --verify returns a digest with change detection',
  errorTaxonomy: 'coordinate errorTaxonomy: backend failure surfaces as a normalized daemon error',
});
