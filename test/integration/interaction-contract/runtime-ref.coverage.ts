import { definePathCoverage } from './coverage-manifest.ts';

export const RUNTIME_REF_COVERAGE = definePathCoverage('runtime-ref', {
  occlusion: 'runtime-ref occlusion: covered ref is refused',
  offscreen: 'runtime-ref offscreen: closed-drawer ref refused with offscreen_ref',
  nonHittable: 'runtime-ref nonHittable: non-hittable ref is annotated but still tapped',
  responseConstruction:
    'runtime-ref responseConstruction: daemon press @ref response carries the canonical ref field set',
  responseIdentity: 'runtime-ref responseIdentity: result echoes the ref target and resolved node',
  verifyEvidence:
    'runtime-ref verifyEvidence: click @ref --verify returns a digest with change detection',
  errorTaxonomy: 'runtime-ref errorTaxonomy: unknown ref fails with the stale-ref hint',
});
