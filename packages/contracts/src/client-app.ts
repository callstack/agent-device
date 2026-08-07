// The public API vocabulary for app install, deploy, open, close and inventory.

import type { AppsFilter } from './app-inventory.ts';
import type { JsonObject } from './json.ts';
import type { SessionSurface } from './session-surface.ts';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';
import type { DaemonInstallSource, SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { PublicPlatform } from '@agent-device/kernel/device';
import type {
  AgentDeviceIdentifiers,
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
  DeviceCommandBaseOptions,
} from './client-connection.ts';
import type { AgentDeviceSessionDevice, StartupPerfSample } from './client-device-view.ts';

export type AppInstallOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    app?: string;
    appPath: string;
  };

export type AppDeployOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    app: string;
    appPath: string;
  };

export type AppDeployResult = {
  app: string;
  appPath: string;
  platform: PublicPlatform;
  appId?: string;
  bundleId?: string;
  package?: string;
  identifiers: AgentDeviceIdentifiers;
};

export type AppOpenOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    app?: string;
    url?: string;
    surface?: SessionSurface;
    activity?: string;
    launchConsole?: string;
    launchArgs?: string[];
    relaunch?: boolean;
    /**
     * RFC prototype (branch claude/observe-foreground): resolve the app target from the
     * sole booted iOS simulator's sole running app instead of an explicit app
     * argument, and return an initial interactive snapshot alongside the open result.
     * Fails closed (AMBIGUOUS_MATCH) unless the environment is unambiguous.
     */
    foreground?: boolean;
    saveScript?: boolean | string;
    /** #1258: overwrite an existing --save-script target instead of refusing. Alias: --overwrite. */
    force?: boolean;
    deviceHub?: boolean;
    testIme?: boolean;
    noRecord?: boolean;
    runtime?: SessionRuntimeHints;
  };

export type AppOpenResult = {
  session: string;
  warnings?: string[];
  sessionStateDir?: string;
  runnerLogPath?: string;
  requestLogPath?: string;
  eventLogPath?: string;
  appName?: string;
  appBundleId?: string;
  appId?: string;
  startup?: StartupPerfSample;
  runtime?: SessionRuntimeHints;
  device?: AgentDeviceSessionDevice;
  /**
   * RFC prototype (open --foreground, branch claude/observe-foreground): the initial
   * interactive snapshot captured immediately after open, composed from the same
   * snapshot-runtime dispatch `agent-device snapshot -i` uses. Present only when
   * `--foreground` triggered the auto-resolve path. Left loosely typed for this
   * prototype rather than reusing `CaptureSnapshotResult` end to end (see PR
   * follow-ups) since the daemon-side composition does not attach client-only
   * fields like `identifiers`.
   */
  snapshot?: Record<string, unknown>;
  identifiers: AgentDeviceIdentifiers;
};

export type AppCloseOptions = AgentDeviceRequestOverrides & {
  app?: string;
  shutdown?: boolean;
  saveScript?: boolean | string;
  /** #1258: overwrite an existing --save-script target instead of refusing. Alias: --overwrite. */
  force?: boolean;
};

export type AppCloseResult = {
  session: string;
  closedApp?: string;
  shutdown?: TargetShutdownResult;
  /**
   * #1258: absolute path of the committed session/healed script when this close
   * published one (`close --save-script`, or a repair-armed session's finalize)
   * — so a client that requested publication learns where the file landed.
   */
  savedScript?: string;
  identifiers: AgentDeviceIdentifiers;
};

export type AppInstallFromSourceOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    source: DaemonInstallSource;
    retainPaths?: boolean;
    retentionMs?: number;
  };

export type AppInstallFromSourceResult = {
  appName?: string;
  appId?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget: string;
  installablePath?: string;
  archivePath?: string;
  materializationId?: string;
  materializationExpiresAt?: string;
  identifiers: AgentDeviceIdentifiers;
};

export type AppListOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    appsFilter?: AppsFilter;
  };

export type AppPushOptions = DeviceCommandBaseOptions & {
  app: string;
  payload: string | JsonObject;
};

export type AppTriggerEventOptions = DeviceCommandBaseOptions & {
  event: string;
  payload?: JsonObject;
};

export type MaterializationReleaseOptions = AgentDeviceRequestOverrides & {
  materializationId: string;
};

export type MaterializationReleaseResult = {
  released: boolean;
  materializationId: string;
  identifiers: AgentDeviceIdentifiers;
};
