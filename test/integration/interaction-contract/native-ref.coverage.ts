import { definePathCoverage } from './coverage-manifest.ts';

export const NATIVE_REF_COVERAGE = definePathCoverage('native-ref', {
  occlusion: 'native-ref occlusion: preflight refuses a covered ref before the backend call',
  offscreen: 'native-ref offscreen: preflight refuses an off-screen ref before the backend call',
  nonHittable:
    'native-ref nonHittable: preflight annotates a non-hittable ref and still calls the backend',
  responseConstruction:
    'native-ref responseConstruction: fast-path result carries the canonical ref field set',
  responseIdentity:
    'native-ref responseIdentity: fast-path result echoes the ref target and backend result',
  verifyEvidence: 'native-ref verifyEvidence: --verify skips the fast path and returns evidence',
  // The preflight raises the runtime path's exact offscreen_ref shape (code,
  // reason, hint), which is the shared taxonomy on this path.
  errorTaxonomy:
    'native-ref offscreen: preflight refuses an off-screen ref before the backend call',
});
