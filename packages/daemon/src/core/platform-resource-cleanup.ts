import type { DeviceInfo } from '@agent-device/kernel/device';

/** Platform-owned resource finalization invoked by neutral daemon orchestration. */
export type PlatformResourceCleanup = Readonly<{
  stopSnapshotHelper(device: DeviceInfo): Promise<void>;
  /**
   * Closes the managed browser when `device` is a web session device. Returns true after that
   * close. Returns false when the platform is not web, or when the device id carries no backend
   * key. A close the backend refuses rejects instead of returning false.
   */
  closeManagedBrowser(
    params: Readonly<{
      /** The web session device whose browser closes; its id carries the backend key. */
      device: DeviceInfo;
      stateDir: string;
      /** The backend keys of the published web sessions. */
      openSessionNames: () => readonly string[];
    }>,
  ): Promise<boolean>;
  cleanupSessionlessExecutionHost(device: DeviceInfo): Promise<void>;
  retainExecutionHostAfterClose(params: {
    device: DeviceInfo;
    shutdownRequested: boolean;
    hasScreenRecording: boolean;
    /** True when the lease is not kept on close, or when its close decision could not be inspected. */
    leaseWillEnd: boolean;
  }): boolean;
}>;
