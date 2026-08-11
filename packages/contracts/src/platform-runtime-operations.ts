import type { AppLogRuntimeHost, AppLogRuntimeOperations } from './app-log-runtime.ts';
import type {
  AppInventoryRuntimeHost,
  AppInventoryRuntimeOperations,
} from './app-inventory-runtime.ts';
import type { NetworkRuntimeHost, NetworkRuntimeOperations } from './network-runtime.ts';
import type { ScreenRecordingRuntimeHost } from './screen-recording-runtime-host.ts';
import type { ScreenRecordingRuntimeOperations } from './screen-recording-runtime.ts';
import type {
  DeviceReadinessRuntimeHost,
  DeviceReadinessRuntimeOperations,
} from './device-readiness-runtime.ts';
import {
  runtimeUse,
  type DeviceRuntimeOwner,
  type RuntimeOwnerRef,
  type RuntimePlatformModule,
} from './platform-runtime.ts';

export type PlatformRuntimeOperations = AppLogRuntimeOperations &
  AppInventoryRuntimeOperations &
  NetworkRuntimeOperations &
  ScreenRecordingRuntimeOperations &
  DeviceReadinessRuntimeOperations;

/**
 * The one neutral runtime-use declaration every command domain shares (ADR 0019 §9): no
 * per-domain currying wrappers. Lives here, next to the concrete `PlatformRuntimeOperations`
 * catalog it closes over, so the generic `runtimeUse` primitive in `platform-runtime.ts`
 * never depends on it.
 */
export const defineUse = runtimeUse<PlatformRuntimeOperations>();

export const bootTargetUse = defineUse({ required: ['bootTarget'] });
export const bootTargetHeadlessUse = defineUse({
  required: ['bootTargetHeadless'],
});
export const appsRuntimeUse = defineUse({ required: ['ensureReady', 'listApps'] });
export const deviceBootRuntimeUses = Object.freeze([bootTargetUse, bootTargetHeadlessUse] as const);

export type DeviceReadinessRuntimePlan =
  | Readonly<{
      kind: 'boot-target';
      operation: 'bootTarget';
      use: typeof bootTargetUse;
    }>
  | Readonly<{
      kind: 'boot-target-headless';
      operation: 'bootTargetHeadless';
      use: typeof bootTargetHeadlessUse;
    }>;

const bootTargetPlan = Object.freeze({
  kind: 'boot-target',
  operation: 'bootTarget',
  use: bootTargetUse,
} as const satisfies DeviceReadinessRuntimePlan);

const bootTargetHeadlessPlan = Object.freeze({
  kind: 'boot-target-headless',
  operation: 'bootTargetHeadless',
  use: bootTargetHeadlessUse,
} as const satisfies DeviceReadinessRuntimePlan);

export function resolveDeviceReadinessRuntimePlan(
  input: Readonly<{
    headless: boolean;
  }>,
): DeviceReadinessRuntimePlan {
  return input.headless ? bootTargetHeadlessPlan : bootTargetPlan;
}

export type PlatformRuntimeHost = AppLogRuntimeHost &
  NetworkRuntimeHost &
  Readonly<{
    appInventory: AppInventoryRuntimeHost;
    screenRecording: ScreenRecordingRuntimeHost;
    deviceReadiness: DeviceReadinessRuntimeHost;
  }>;

export type PlatformRuntimeOwner = DeviceRuntimeOwner<PlatformRuntimeOperations>;

export type PlatformRuntimeModule = RuntimePlatformModule<
  PlatformRuntimeOperations,
  PlatformRuntimeHost
>;

/** Cheap exact-owner metadata stays eager; provider mechanics remain lazy until selection. */
export type PlatformRuntimeProviderModule = Readonly<{
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
  loadRuntime(host: PlatformRuntimeHost): Promise<PlatformRuntimeOwner>;
}>;
