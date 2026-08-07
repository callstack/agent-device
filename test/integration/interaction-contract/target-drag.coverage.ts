import { definePathCoverage } from './coverage-manifest.ts';

const DUAL_ENDPOINT_SUCCESS =
  'target-drag dual endpoints: an equivalent destination wrapper chain resolves, discloses identity, and dispatches one gesture';

export const TARGET_DRAG_COVERAGE = definePathCoverage('target-drag', {
  disambiguation: DUAL_ENDPOINT_SUCCESS,
  occlusion: 'target-drag occlusion: a covered destination is refused before gesture dispatch',
  offscreen: 'target-drag offscreen: an off-screen source is refused before gesture dispatch',
  responseConstruction:
    'target-drag responseConstruction: daemon response carries the canonical dual-target gesture shape',
  responseIdentity: DUAL_ENDPOINT_SUCCESS,
  errorTaxonomy:
    'target-drag errorTaxonomy: a missing destination carries shared selector diagnostics',
  resolutionDisclosure: DUAL_ENDPOINT_SUCCESS,
});
