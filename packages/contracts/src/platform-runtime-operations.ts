import type { AppLogRuntimeHost, AppLogRuntimeOperations } from './app-log-runtime.ts';
import type {
  AppInventoryRuntimeHost,
  AppInventoryRuntimeOperations,
} from './app-inventory-runtime.ts';
import type {
  AndroidAppDeploymentExecutor,
  AppDeploymentRuntimeOperations,
  AppleAppDeploymentExecutor,
} from './app-deployment-runtime.ts';
import type { AppStateRuntimeHost, AppStateRuntimeOperations } from './app-state-runtime.ts';
import type { NetworkRuntimeHost, NetworkRuntimeOperations } from './network-runtime.ts';
import type { ScreenRecordingRuntimeHost } from './screen-recording-runtime-host.ts';
import type { ScreenRecordingRuntimeOperations } from './screen-recording-runtime.ts';
import type { ScreenshotRuntimeOperations } from './screenshot-runtime.ts';
import type { SnapshotRuntimeHost, SnapshotRuntimeOperations } from './snapshot-runtime.ts';
import type { ViewportRuntimeOperations } from './viewport-runtime.ts';
import type {
  DeviceReadinessRuntimeHost,
  DeviceReadinessRuntimeOperations,
} from './device-readiness-runtime.ts';
import type {
  DeviceShutdownRuntimeHost,
  DeviceShutdownRuntimeOperations,
} from './device-shutdown-runtime.ts';
import type {
  AndroidApplicationTools,
  AppleApplicationTools,
  ApplicationLifecycleResourceLifecycle,
  ApplicationLifecycleRuntimeOperations,
  LocalApplicationInteractorHost,
} from './application-lifecycle-runtime.ts';
import {
  type DeviceRuntimeOwner,
  type RuntimeOwnerRef,
  type RuntimePlatformModule,
} from './platform-runtime.ts';
import { runtimeUse } from './platform-runtime-use.ts';
import type { AndroidToolHost } from './platform-runtime-host.ts';

export type PlatformRuntimeOperations = AppLogRuntimeOperations &
  AppInventoryRuntimeOperations &
  AppDeploymentRuntimeOperations &
  AppStateRuntimeOperations &
  NetworkRuntimeOperations &
  ScreenRecordingRuntimeOperations &
  ScreenshotRuntimeOperations &
  SnapshotRuntimeOperations &
  ViewportRuntimeOperations &
  DeviceReadinessRuntimeOperations &
  DeviceShutdownRuntimeOperations &
  ApplicationLifecycleRuntimeOperations;

/**
 * The one neutral runtime-use declaration every command domain shares (ADR 0019 §9): no
 * per-domain currying wrappers. Lives here, next to the concrete `PlatformRuntimeOperations`
 * catalog it closes over, so the generic `runtimeUse` primitive stays independent of this
 * command-domain catalog.
 */
export const defineUse = runtimeUse<PlatformRuntimeOperations>();

export const bootTargetUse = defineUse({ required: ['bootTarget'] });
export const bootTargetHeadlessUse = defineUse({
  required: ['bootTargetHeadless'],
});
export const appsRuntimeUse = defineUse({ required: ['ensureReady', 'listApps'] });
export const captureSnapshotUse = defineUse({ required: ['captureSnapshot'] });
export const viewportRuntimeUse = defineUse({ required: ['setViewport'] });
const captureSnapshotWithCustomActionsUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithCustomActions'],
});
const captureSnapshotWithoutActiveAppUse = defineUse({
  required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
});
const captureSnapshotWithCustomActionsWithoutActiveAppUse = defineUse({
  required: [
    'captureSnapshot',
    'captureSnapshotWithCustomActions',
    'captureSnapshotWithoutActiveApp',
  ],
});

export const snapshotRuntimePlanUses = Object.freeze([
  captureSnapshotUse,
  captureSnapshotWithCustomActionsUse,
  captureSnapshotWithoutActiveAppUse,
  captureSnapshotWithCustomActionsWithoutActiveAppUse,
] as const);

export type SnapshotRuntimePlan =
  | Readonly<{
      kind: 'active-app';
      operation: 'captureSnapshot';
      use: typeof captureSnapshotUse;
    }>
  | Readonly<{
      kind: 'custom-actions-active-app';
      operation: 'captureSnapshotWithCustomActions';
      use: typeof captureSnapshotWithCustomActionsUse;
    }>
  | Readonly<{
      kind: 'custom-actions-without-active-app';
      operation: 'captureSnapshotWithCustomActions';
      use: typeof captureSnapshotWithCustomActionsWithoutActiveAppUse;
    }>
  | Readonly<{
      kind: 'without-active-app';
      operation: 'captureSnapshotWithoutActiveApp';
      use: typeof captureSnapshotWithoutActiveAppUse;
    }>;

/** Selects one owner-fact-backed capture plan from normalized command/session intent. */
export function resolveSnapshotRuntimePlan(input: {
  customActions: boolean;
  hasActiveApp: boolean;
}): SnapshotRuntimePlan {
  if (input.customActions) {
    return input.hasActiveApp
      ? Object.freeze({
          kind: 'custom-actions-active-app',
          operation: 'captureSnapshotWithCustomActions',
          use: captureSnapshotWithCustomActionsUse,
        })
      : Object.freeze({
          kind: 'custom-actions-without-active-app',
          operation: 'captureSnapshotWithCustomActions',
          use: captureSnapshotWithCustomActionsWithoutActiveAppUse,
        });
  }
  return input.hasActiveApp
    ? Object.freeze({ kind: 'active-app', operation: 'captureSnapshot', use: captureSnapshotUse })
    : Object.freeze({
        kind: 'without-active-app',
        operation: 'captureSnapshotWithoutActiveApp',
        use: captureSnapshotWithoutActiveAppUse,
      });
}

const captureScreenshotUse = defineUse({ required: ['captureScreenshot'] });
/**
 * `--overlay-refs` annotates the capture with the refs of a snapshot taken in the same request, so
 * the snapshot is part of what the command requires — not something to discover after the PNG is
 * already on disk. Declaring it in the use is what lets admission refuse the whole request up
 * front on a target that can capture pixels but not a tree.
 */
const captureScreenshotWithOverlayRefsUse = defineUse({
  required: ['captureScreenshot', 'captureSnapshot'],
});

export const screenshotRuntimePlanUses = Object.freeze([
  captureScreenshotUse,
  captureScreenshotWithOverlayRefsUse,
] as const);

export type ScreenshotRuntimePlan =
  | Readonly<{ kind: 'capture'; use: typeof captureScreenshotUse }>
  | Readonly<{
      kind: 'capture-with-overlay-refs';
      use: typeof captureScreenshotWithOverlayRefsUse;
    }>;

/** Selects one owner-fact-backed capture plan from normalized command intent. */
export function resolveScreenshotRuntimePlan(
  input: Readonly<{ overlayRefs: boolean }>,
): ScreenshotRuntimePlan {
  return input.overlayRefs
    ? Object.freeze({
        kind: 'capture-with-overlay-refs',
        use: captureScreenshotWithOverlayRefsUse,
      })
    : Object.freeze({ kind: 'capture', use: captureScreenshotUse });
}
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
export const appStateUse = defineUse({ required: ['ensureReady', 'appState'] });
export const appStateRuntimeUses = Object.freeze([appStateUse] as const);

export const shutdownTargetUse = defineUse({ required: ['shutdownTarget'] });

export type PlatformRuntimeHost = AppLogRuntimeHost &
  NetworkRuntimeHost &
  Readonly<{
    appInventory: AppInventoryRuntimeHost;
    appState: AppStateRuntimeHost;
    /** Focused native ports; deployment semantics remain in the owning family packages. */
    appleDeployment: AppleAppDeploymentExecutor;
    androidDeployment: AndroidAppDeploymentExecutor;
    androidTools: AndroidToolHost;
    temporaryFiles: Readonly<{
      create(
        options: Readonly<{ prefix: string; suffix: string }>,
      ): Promise<import('./platform-runtime-host.ts').HostTemporaryTextFile>;
    }>;
    screenRecording: ScreenRecordingRuntimeHost;
    snapshot: SnapshotRuntimeHost;
    deviceReadiness: DeviceReadinessRuntimeHost;
    deviceShutdown: DeviceShutdownRuntimeHost;
    localInteractors: LocalApplicationInteractorHost;
    appleApplications: AppleApplicationTools;
    androidApplications: AndroidApplicationTools;
    applicationResources: ApplicationLifecycleResourceLifecycle;
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
