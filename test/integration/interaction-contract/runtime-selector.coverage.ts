import { definePathCoverage } from './coverage-manifest.ts';

export const RUNTIME_SELECTOR_COVERAGE = definePathCoverage('runtime-selector', {
  disambiguation: 'runtime-selector disambiguation: visible tab wins over the closed-drawer twin',
  occlusion: 'runtime-selector occlusion: covered button is refused',
  offscreen: [
    'runtime-selector offscreen: closed drawer refused with offscreen_selector',
    'runtime-selector offscreen: edge-grazing container is still refused',
  ],
  nonHittable: 'runtime-selector nonHittable: non-hittable match is annotated but still tapped',
  responseConstruction:
    'runtime-selector responseConstruction: daemon press response carries the canonical selector field set',
  responseIdentity:
    'runtime-selector responseIdentity: result echoes selectorChain and the resolved node',
  verifyEvidence:
    'runtime-selector verifyEvidence: press --verify returns a digest with change detection',
  settleObservation:
    'runtime-selector settleObservation: press --settle returns the settled diff with fresh refs',
  errorTaxonomy:
    'runtime-selector errorTaxonomy: no-match failure carries the shared code and hint',
});
