import { definePathCoverage } from './coverage-manifest.ts';

const DIRECT_MAESTRO_CLICK_SCENARIO =
  'maestro-direct-selector responseConstruction and resolutionDisclosure: allowed fallback not taken keeps direct-iOS resolution';

export const MAESTRO_DIRECT_SELECTOR_COVERAGE = definePathCoverage('maestro-direct-selector', {
  responseConstruction: DIRECT_MAESTRO_CLICK_SCENARIO,
  resolutionDisclosure: DIRECT_MAESTRO_CLICK_SCENARIO,
});
