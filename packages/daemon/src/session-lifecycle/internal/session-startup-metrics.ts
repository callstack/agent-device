export const STARTUP_SAMPLE_METHOD = 'open-command-roundtrip';

export type StartupPerfSample = {
  durationMs: number;
  measuredAt: string;
  method: typeof STARTUP_SAMPLE_METHOD;
  appTarget?: string;
  appBundleId?: string;
};
