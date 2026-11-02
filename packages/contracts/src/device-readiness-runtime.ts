import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';
import type { DeviceInventoryRequest } from './device-inventory.ts';

/** Typed `details.reason` every platform reports when the boot deadline expires. */
export const BOOT_TIMEOUT_REASON = 'boot_timeout';

export type EnsureReadyInput = Readonly<{
  serial?: string;
  androidSerialAllowlist?: readonly string[];
  /**
   * Absolute deadline (epoch ms), from `boot --timeout`, already validated finite and positive.
   * Bounds a cold boot wait; the Apple and Android runtimes honor it. HarmonyOS, Vega, and Linux
   * have no boot wait to bound.
   */
  deadlineAtMs?: number;
}>;

export type DeviceReadinessRuntimeOperations = Readonly<{
  ensureReady(input: EnsureReadyInput): Promise<DeviceInfo>;
  bootTarget(input: EnsureReadyInput): Promise<DeviceInfo>;
  bootTargetHeadless(input: EnsureReadyInput): Promise<DeviceInfo>;
}>;

/**
 * One run of the operator's device boot hook: its argv and what it printed. `failure` says why it
 * did not exit on its own (it could not start, or ran out of time); `exitCode` is then null.
 */
export type DeviceBootHookRun = Readonly<{
  command: readonly string[];
  exitCode: number | null;
  failure?: string;
  stdout: string;
  stderr: string;
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
    launch(avdName: string, headless: boolean, bootBudgetMs: number): Promise<number>;
    terminate(pid: number): Promise<void>;
  }>;
  /**
   * The operator's boot hook, `boot-hook.json` in the daemon state directory. `run` returns null
   * when none is configured, and readiness boots the device itself. After a run, readiness reads
   * the device state again and throws `leftDeviceDown` when it is still not booted: it never boots
   * the device itself then, because the hook's owner admits devices.
   */
  bootHook: Readonly<{
    run(
      device: DeviceInfo,
      signal?: AbortSignal,
      options?: Readonly<{ deadlineAtMs?: number }>,
    ): Promise<DeviceBootHookRun | null>;
    leftDeviceDown(run: DeviceBootHookRun, device: DeviceInfo): AppError;
  }>;
}>;
