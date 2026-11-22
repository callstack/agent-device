import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from './device-inventory.ts';

/** Typed `details.reason` every platform reports when the boot deadline expires. */
export const BOOT_TIMEOUT_REASON = 'boot_timeout';

export type AndroidEmulatorLaunchIdentity = Readonly<{ pid: number; startTime: string }>;

export type EnsureReadyInput = Readonly<{
  /**
   * Reports the emulator process THIS boot launched, once the host knows about it: the recorded
   * identity when the host could read the process's start time, and nothing when it could not. A boot
   * that found the device already running reports nothing at all, so a caller that hears this can
   * never mistake somebody else's running emulator for its own launch.
   */
  onAndroidEmulatorLaunch?: (identity: AndroidEmulatorLaunchIdentity | undefined) => void;
  /**
   * Whether a session or a device claim already names `device` as its own, asked of `device` before a
   * boot that failed stops the emulator it launched. Only a caller that can read session and claim
   * state — the daemon — supplies this; a caller that answers nothing leaves the boot's own rule to
   * decide, which is what every non-daemon route (a `boot` command, the local CLI) does.
   */
  isAndroidEmulatorHeldByOther?: (device: DeviceInfo) => Promise<boolean>;
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
    /**
     * What this host's `launch` of `pid` recorded about the emulator process it started, or nothing
     * when that launch is unknown here or its start time could not be read. The caller records it
     * beside the serial the launch came up on, so a later stop can prove the running emulator is
     * still that process.
     */
    bindLaunchedEmulator?(
      pid: number,
      device: DeviceInfo,
    ): Promise<AndroidEmulatorLaunchIdentity | undefined>;
    /**
     * Stops the emulator process this host's `launch` of `pid` started, and throws without signaling
     * when the daemon's policy denies `device-shutdown`. A caller that must not lose its own failure
     * catches that refusal: the launch stays running.
     */
    terminate(pid: number): Promise<void>;
  }>;
}>;
