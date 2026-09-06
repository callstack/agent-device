import type { DeviceInfo } from '@agent-device/kernel/device';

/** Platform-owned resource finalization invoked by neutral daemon orchestration. */
export type PlatformResourceCleanup = Readonly<{
  stopSnapshotHelper(device: DeviceInfo): Promise<void>;
  closeManagedBrowser(
    params: Readonly<{
      device: DeviceInfo;
      sessionName: string;
      stateDir: string;
      openSessionNames: () => readonly string[];
    }>,
  ): Promise<void>;
  cleanupSessionlessExecutionHost(device: DeviceInfo): Promise<void>;
  retainExecutionHostAfterClose(params: {
    device: DeviceInfo;
    shutdownRequested: boolean;
    hasScreenRecording: boolean;
    hasLease: boolean;
  }): boolean;
}>;
