import { definePathCoverage } from './coverage-manifest.ts';

export const MAESTRO_FALLBACK_COVERAGE = definePathCoverage('maestro-non-hittable-fallback', {
  offscreen:
    'maestro-non-hittable-fallback offscreen: runner ELEMENT_OFFSCREEN falls back to the runtime refusal',
  responseConstruction:
    'maestro-non-hittable-fallback responseConstruction: fallback tap response carries the canonical field set and fallback markers',
});
