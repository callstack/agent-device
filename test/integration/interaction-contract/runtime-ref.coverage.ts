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
  settleObservation:
    'runtime-ref settleObservation: press @ref --settle diffs the settled tree against the stored baseline',
  errorTaxonomy: 'runtime-ref errorTaxonomy: unknown ref fails with the stale-ref hint',
  resolutionDisclosure: [
    'runtime-ref resolutionDisclosure: an @ref discloses the exact ref-provenance shape',
    'runtime-ref resolutionDisclosure: trailing-label recovery discloses label-fallback, never exact',
  ],
});
