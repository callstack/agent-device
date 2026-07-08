import type { DeviceKind, PublicPlatform } from '../kernel/device.ts';
import type { JsonObject } from './json.ts';

export type PrepareIosRunnerCacheKind = 'exact' | 'restore-key' | 'miss' | 'external';
export type PrepareIosRunnerArtifactState = 'valid' | 'rebuilt';

export type PrepareIosRunnerTiming = {
  totalMs: number;
  additiveParts: {
    buildMs?: number;
    connectAfterBuildMs: number;
    healthCheckMs: number;
  };
  containment: { connectMs?: ['buildMs']; healthCheckMs: [] };
  note: string;
};

/**
 * Public daemon result for `prepare ios-runner`. The runner-local prepare result
 * is projected by `prepareIosRunnerResponseData` with device identity and timing
 * guidance before it reaches the client.
 */
export type PrepareCommandResult = {
  action: 'ios-runner';
  platform: PublicPlatform;
  deviceId: string;
  deviceName: string;
  kind: DeviceKind;
  durationMs: number;
  runner: JsonObject;
  cache?: PrepareIosRunnerCacheKind;
  artifact?: PrepareIosRunnerArtifactState;
  buildMs?: number;
  connectMs: number;
  healthCheckMs: number;
  xctestrunPath?: string;
  recoveryReason?: string;
  failureReason?: string;
  timing: PrepareIosRunnerTiming;
  message: string;
};
