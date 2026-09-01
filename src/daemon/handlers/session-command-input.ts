import type { LeaseLifecycleProvider, ProviderAppCatalog } from '@agent-device/contracts/device';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import type { AppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import type { AudioProbeAdmissionLedger } from '../audio-probe-admission-ledger.ts';
import type { DeviceClaimReconciler } from '../device-claims.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../request-runtime-binding.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { SessionStore } from '../session-store.ts';
import type { PerfCaptureAdmissionLedger } from '../perf-capture-admission-ledger.ts';

export type SessionCommandInput = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry?: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  providerAppCatalog?: ProviderAppCatalog;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  /** Request-scoped Android adb transport override, opaque to the daemon. */
  androidAdbExecutor?: unknown;
  bindDevice?: BindDeviceRuntime;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindExactDevice?: BindExactDeviceRuntime;
  appLogAdmissionLedger?: AppLogAdmissionLedger;
  audioProbeAdmissionLedger?: AudioProbeAdmissionLedger;
  perfCaptureAdmissionLedger?: PerfCaptureAdmissionLedger;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  hostDiagnostics?: HostDiagnostics;
  requestScope?: PlatformRequestScope;
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  throwIfCanceled?: () => void;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  platformResourceCleanup?: PlatformResourceCleanup;
};

export type SessionCommandParams = Omit<SessionCommandInput, 'leaseRegistry'> & {
  leaseRegistry: LeaseRegistry;
};

export type SessionCommandHandler = (
  params: SessionCommandParams,
) => Promise<DaemonResponse | null>;
