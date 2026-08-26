import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOwnerRef } from './platform-runtime.ts';
import type {
  PerfData,
  PerfNativeCaptureRecoveryInput,
  PerfNativeCaptureStartInput,
  PerfNativeCaptureStartResult,
  PerfProfileReportInput,
  PerfRuntimeOperations,
} from './perf-runtime.ts';

type NativeCaptureHost = Readonly<{
  start(
    device: DeviceInfo,
    owner: RuntimeOwnerRef,
    input: PerfNativeCaptureStartInput,
  ): Promise<PerfNativeCaptureStartResult>;
  reattach(
    device: DeviceInfo,
    input: PerfNativeCaptureRecoveryInput,
  ): ReturnType<PerfRuntimeOperations['perfNativeCaptureReattach']>;
  cleanup(
    device: DeviceInfo,
    input: PerfNativeCaptureRecoveryInput,
  ): ReturnType<PerfRuntimeOperations['perfNativeCaptureCleanup']>;
}>;

export type ApplePerfHost = NativeCaptureHost &
  Readonly<{
    sampleFrames(device: DeviceInfo, appId: string): Promise<object>;
    frameSampling(device: DeviceInfo): Promise<PerfData>;
    sampleMemory(device: DeviceInfo, appId: string): Promise<object>;
    memorySampling(device: DeviceInfo): Promise<PerfData>;
    memorySnapshotSupport(device: DeviceInfo): Promise<PerfData>;
    captureMemorySnapshot(device: DeviceInfo, appId: string, outputPath: string): Promise<PerfData>;
    writeProfileReport(input: PerfProfileReportInput): Promise<PerfData>;
  }>;

export type AndroidPerfHost = NativeCaptureHost &
  Readonly<{
    sampleFrames(device: DeviceInfo, appId: string): Promise<object>;
    sampleMemory(device: DeviceInfo, appId: string): Promise<object>;
    captureMemorySnapshot(device: DeviceInfo, appId: string, outputPath: string): Promise<PerfData>;
    writeProfileReport(device: DeviceInfo, input: PerfProfileReportInput): Promise<PerfData>;
  }>;

export type HarmonyPerfHost = Readonly<{
  sampleMemory(device: DeviceInfo, appId: string): Promise<object>;
}>;

/** Family-specific native mechanics; platform packages own policy and operation construction. */
export type PerfRuntimeHost = Readonly<{
  apple: ApplePerfHost;
  android: AndroidPerfHost;
  harmony: HarmonyPerfHost;
}>;
