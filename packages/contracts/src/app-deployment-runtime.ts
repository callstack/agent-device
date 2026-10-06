import type { DeviceInfo } from '@agent-device/kernel/device';
import type { JsonObject } from './json.ts';

/** A short-lived install source supplied by the daemon after request validation. */
export type AppDeploymentSource =
  | Readonly<{ kind: 'url'; url: string; headers?: Readonly<Record<string, string>> }>
  | Readonly<{ kind: 'path'; path: string }>;

/**
 * Request-scoped materialization. The daemon owns cleanup and retention; this handle must never
 * be persisted into session state or a durable resource envelope.
 */
export type MaterializedAppSource = Readonly<{
  archivePath?: string;
  installablePath: string;
  /**
   * The single file a hosted provider uploads for this build, named by the materializer that knows
   * its format. Absent when the installable is already that file or no such file exists.
   */
  uploadPath?: string;
  bundleId?: string;
  packageName?: string;
  appName?: string;
  cleanup(): Promise<void>;
}>;

export type AppDeploymentInput = Readonly<{
  app: string;
  appPath: string;
  replaceExisting: boolean;
}>;

export type AppDeploymentResult = Readonly<{
  bundleId?: string;
  packageName?: string;
  appName?: string;
  launchTarget?: string;
}>;

export type MaterializeAppSourceInput = Readonly<{
  source: AppDeploymentSource;
}>;

export type DeployMaterializedAppInput = Readonly<{
  artifact: MaterializedAppSource;
}>;

export type PushNotificationInput = Readonly<{
  appId: string;
  payload: JsonObject;
}>;

export type PushNotificationResult = Readonly<{
  action?: string;
  extrasCount?: number;
}>;

/** The request-scoped deployment facet; no operation creates a durable resource. */
export type AppDeploymentRuntimeOperations = Readonly<{
  deployApp(input: AppDeploymentInput): Promise<AppDeploymentResult>;
  materializeAppSource(input: MaterializeAppSourceInput): Promise<MaterializedAppSource>;
  deployMaterializedApp(input: DeployMaterializedAppInput): Promise<AppDeploymentResult>;
  sendPushNotification(input: PushNotificationInput): Promise<PushNotificationResult>;
}>;

/**
 * The Apple package owns deployment sequencing. Composition supplies only these native executor
 * calls, each scoped to the request binding that initiated it.
 */
export type AppleAppDeploymentExecutor = Readonly<{
  /** Brackets a full reinstall so fuzzy iOS app identity cannot survive a partial replacement. */
  withInvalidatedAppResolutionCache<Result>(
    device: DeviceInfo,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  prepareArtifact(
    input: MaterializeAppSourceInput,
    options: Readonly<{ appIdentifierHint?: string; signal: AbortSignal }>,
  ): Promise<MaterializedAppSource>;
  resolveAppBundleId(device: DeviceInfo, app: string): Promise<string>;
}>;

/**
 * The Android package owns deployment sequencing and native command construction. Composition
 * supplies only the temporary legacy artifact and fuzzy-resolution seams.
 */
export type AndroidAppDeploymentExecutor = Readonly<{
  /** Inert composition-time configuration; command construction remains package-owned. */
  bundletoolJar?: string;
  /** Brackets one deploy lifecycle so fuzzy target resolution is clear before and after it. */
  withInvalidatedAppResolutionCache<Result>(
    device: DeviceInfo,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  prepareArtifact(
    input: MaterializeAppSourceInput,
    options: Readonly<{ resolveIdentity?: boolean; signal: AbortSignal }>,
  ): Promise<MaterializedAppSource>;
  resolveAppPackage(device: DeviceInfo, app: string): Promise<string>;
}>;
