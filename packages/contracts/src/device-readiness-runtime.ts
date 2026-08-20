import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from './device-inventory.ts';

export type EnsureReadyInput = Readonly<{
  serial?: string;
  androidSerialAllowlist?: readonly string[];
}>;

export type DeviceReadinessRuntimeOperations = Readonly<{
  ensureReady(input: EnsureReadyInput): Promise<DeviceInfo>;
  bootTarget(input: EnsureReadyInput): Promise<DeviceInfo>;
  bootTargetHeadless(input: EnsureReadyInput): Promise<DeviceInfo>;
}>;

export type DeviceReadinessRuntimeHost = Readonly<{
  applePhysical: Readonly<{
    ensureConnected(device: DeviceInfo, signal: AbortSignal): Promise<void>;
  }>;
  appleAutomation: Readonly<{
    keepHot(device: DeviceInfo): void;
    /** Reads the bounded memo populated only by a fresh native Booted observation. */
    wasRecentlyObservedBooted(device: DeviceInfo): Promise<boolean>;
    /**
     * Publishes a FRESH Booted observation. `simctl list devices -j` costs ~0.7s per spawn and one
     * flow makes several boot checks, so the host memoizes what readiness just observed. Callers
     * must never publish a cached or persisted listing.
     */
    markBooted(device: DeviceInfo): void;
  }>;
  androidEmulator: Readonly<{
    discover(request: DeviceInventoryRequest, signal: AbortSignal): Promise<readonly DeviceInfo[]>;
    launch(avdName: string, headless: boolean): number;
    terminate(pid: number): Promise<void>;
  }>;
}>;
