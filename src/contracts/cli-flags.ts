import type { SessionSurface } from './session-surface.ts';
import type { RecordingExportQuality } from '../core/recording-export-quality.ts';
import type { BackMode } from './back-mode.ts';
import type { ClickButton } from '../core/click-button.ts';
import type { SwipePattern } from './scroll-gesture.ts';
import type { DeviceTarget, PlatformSelector } from '../kernel/device.ts';
import type {
  DaemonInstallSource,
  DaemonServerMode,
  DaemonTransportPreference,
  LeaseBackend,
  NetworkIncludeMode,
  ResponseLevel,
  SessionIsolationMode,
  SessionRuntimeHints,
} from '../kernel/contracts.ts';
import type {
  CloudProviderProfileFields,
  RemoteConfigMetroOptions,
} from '../remote/remote-config-schema.ts';
import type { ScreenshotRequestFlags } from './screenshot.ts';
import type { RecordingScope } from './recording-scope.ts';

export type CliFlags = CloudProviderProfileFields &
  RemoteConfigMetroOptions &
  ScreenshotRequestFlags & {
    json: boolean;
    config?: string;
    remoteConfig?: string;
    stateDir?: string;
    daemonBaseUrl?: string;
    daemonAuthToken?: string;
    daemonTransport?: DaemonTransportPreference;
    daemonServerMode?: DaemonServerMode;
    proxyHost?: string;
    proxyPort?: number;
    tenant?: string;
    sessionIsolation?: SessionIsolationMode;
    runId?: string;
    leaseId?: string;
    leaseBackend?: LeaseBackend;
    provider?: string;
    providerSessionId?: string;
    force?: boolean;
    noLogin?: boolean;
    kind?: string;
    perfTemplate?: string;
    sessionLock?: 'reject' | 'strip';
    sessionLocked?: boolean;
    sessionLockConflicts?: 'reject' | 'strip';
    platform?: PlatformSelector;
    target?: DeviceTarget;
    device?: string;
    udid?: string;
    serial?: string;
    iosSimulatorDeviceSet?: string;
    iosXctestrunFile?: string;
    iosXctestDerivedDataPath?: string;
    iosXctestEnvDir?: string;
    deviceHub?: boolean;
    testIme?: boolean;
    androidDeviceAllowlist?: string;
    remote?: boolean;
    session?: string;
    targetApp?: string;
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
    verbose?: boolean;
    cost?: boolean;
    responseLevel?: ResponseLevel;
    snapshotInteractiveOnly?: boolean;
    snapshotDiff?: boolean;
    snapshotDepth?: number;
    snapshotScope?: string;
    snapshotRaw?: boolean;
    snapshotForceFull?: boolean;
    artifact?: string;
    dsym?: string;
    searchPath?: string;
    networkInclude?: NetworkIncludeMode;
    baseline?: string;
    threshold?: string;
    appsFilter?: 'user-installed' | 'all';
    count?: number;
    fps?: number;
    quality?: RecordingExportQuality | string;
    hideTouches?: boolean;
    recordingScope?: RecordingScope;
    intervalMs?: number;
    delayMs?: number;
    durationMs?: number;
    holdMs?: number;
    jitterPx?: number;
    pixels?: number;
    doubleTap?: boolean;
    verify?: boolean;
    settle?: boolean;
    settleQuietMs?: number;
    clickButton?: ClickButton;
    backMode?: BackMode;
    pauseMs?: number;
    pattern?: SwipePattern;
    activity?: string;
    launchConsole?: string;
    launchArgs?: string[];
    header?: string[];
    githubActionsArtifact?: string;
    installSource?: DaemonInstallSource;
    saveScript?: boolean | string;
    shutdown?: boolean;
    relaunch?: boolean;
    surface?: SessionSurface;
    headless?: boolean;
    restart?: boolean;
    noRecord?: boolean;
    retainPaths?: boolean;
    retentionMs?: number;
    replayUpdate?: boolean;
    replayMaestro?: boolean;
    replayExportFormat?: 'maestro';
    replayEnv?: string[];
    replayShellEnv?: Record<string, string>;
    replayFrom?: number;
    replayPlanDigest?: string;
    failFast?: boolean;
    timeoutMs?: number;
    retries?: number;
    recordVideo?: boolean;
    artifactsDir?: string;
    reporter?: string[];
    reportJunit?: string;
    shardAll?: number;
    shardSplit?: number;
    steps?: string;
    stepsFile?: string;
    findFirst?: boolean;
    findLast?: boolean;
    batchOnError?: 'stop';
    batchMaxSteps?: number;
    batchSteps?: Array<{
      command: string;
      input: Record<string, unknown>;
      runtime?: SessionRuntimeHints;
    }>;
    out?: string;
    help: boolean;
    version: boolean;
  };

export type DaemonExcludedCliFlag = 'json' | 'help' | 'version' | 'batchSteps' | 'replayMaestro';
