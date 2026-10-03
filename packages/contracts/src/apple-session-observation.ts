import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from './device-inventory.ts';

export type AppleSessionObservation = Readonly<{
  observeRunnerSession(
    deviceId: string,
  ): Promise<Readonly<{ alive: boolean; sessionId: string }> | undefined>;
  /**
   * Exactly one booted iOS simulator with one running app in its device set, or undefined.
   * Ambiguous or failed probes are inconclusive; cancellation and missing context propagate.
   */
  resolveSoleForegroundApp(
    options?: Readonly<{ simulatorSetPath?: string }>,
  ): Promise<Readonly<{ device: DeviceInfo; app: Readonly<{ bundleId: string }> }> | undefined>;
}>;

export type AppleSessionObservationHost = Readonly<{
  listLocalDevices(request: DeviceInventoryRequest): Promise<DeviceInfo[]>;
  shouldPropagateProbeError(error: unknown): boolean;
}>;
