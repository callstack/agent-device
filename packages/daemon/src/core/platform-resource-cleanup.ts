import type { DeviceInfo } from '@agent-device/kernel/device';

/** Platform-owned resource finalization invoked by neutral daemon orchestration. */
export type PlatformResourceCleanup = Readonly<{
  stopSnapshotHelper(device: DeviceInfo): Promise<void>;
  closeManagedBrowser(
    params: Readonly<{
      /** The web session device whose browser closes; its id carries the backend key. */
      device: DeviceInfo;
      stateDir: string;
      /** The backend keys of the published web sessions. */
      openSessionNames: () => readonly string[];
    }>,
  ): Promise<void>;
  cleanupSessionlessExecutionHost(device: DeviceInfo): Promise<void>;
  retainExecutionHostAfterClose(params: {
    device: DeviceInfo;
    shutdownRequested: boolean;
    hasScreenRecording: boolean;
    /** True when the lease is not kept on close, or when its close decision could not be inspected. */
    leaseWillEnd: boolean;
  }): boolean;
}>;
