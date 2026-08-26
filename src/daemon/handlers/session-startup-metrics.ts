export const STARTUP_SAMPLE_METHOD = 'open-command-roundtrip';
export const PERF_UNAVAILABLE_REASON = 'Not implemented for this platform in this release.';

export type StartupPerfSample = {
  durationMs: number;
  measuredAt: string;
  method: typeof STARTUP_SAMPLE_METHOD;
  appTarget?: string;
  appBundleId?: string;
};
