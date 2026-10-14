import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import type { LeaseLifecycleProvider, ProviderAppCatalog } from '@agent-device/contracts/device';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';
import type { AppLogAdmissionLedger } from '../../resources/app-log-admission-ledger.ts';
import { type AudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import { type PerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { type ScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import type { DeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claims';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import type { SessionStore } from '../../core/session-store.ts';

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
  platformServices: DaemonPlatformServices;
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
  createCommandSurface: CreateDaemonCommandSurface;
  platformResourceCleanup?: PlatformResourceCleanup;
};

export type SessionCommandParams = Omit<SessionCommandInput, 'leaseRegistry'> & {
  leaseRegistry: LeaseRegistry;
};

export type SessionCommandHandler = (
  params: SessionCommandParams,
) => Promise<DaemonResponse | null>;
