import { SESSION_SURFACES, type SessionSurface } from '../../core/session-surface.ts';
import type { RecordingExportQuality } from '../../core/recording-export-quality.ts';
import type { BackMode } from '../../core/back-mode.ts';
import type { ClickButton } from '../../core/click-button.ts';
import type { SwipePattern } from '../../core/scroll-gesture.ts';
import {
  PLATFORM_SELECTORS,
  type DeviceTarget,
  type PlatformSelector,
} from '../../kernel/device.ts';
import {
  type DaemonInstallSource,
  type DaemonServerMode,
  type DaemonTransportPreference,
  type LeaseBackend,
  type NetworkIncludeMode,
  RESPONSE_LEVELS,
  type ResponseLevel,
  type SessionRuntimeHints,
  type SessionIsolationMode,
} from '../../kernel/contracts.ts';
import type {
  CloudProviderProfileFields,
  RemoteConfigMetroOptions,
} from '../../remote/remote-config-schema.ts';
import {
  SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS,
  type ScreenshotRequestFlags,
} from '../../contracts/screenshot.ts';
import { PERF_KIND_VALUES } from '../../contracts/perf.ts';
import {
  MAESTRO_COMPAT_TRACKER_URL,
  formatMaestroSupportedSubsetForCli,
} from '../../compat/maestro/support-matrix.ts';

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
    intervalMs?: number;
    delayMs?: number;
    durationMs?: number;
    holdMs?: number;
    jitterPx?: number;
    pixels?: number;
    doubleTap?: boolean;
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

export type FlagKey = keyof CliFlags;
type FlagType = 'boolean' | 'int' | 'enum' | 'string' | 'booleanOrString';

export type FlagDefinition = {
  key: FlagKey;
  names: readonly string[];
  type: FlagType;
  multiple?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  setValue?: CliFlags[FlagKey];
  usageLabel?: string;
  usageDescription?: string;
};

function flagKeys<const TKeys extends readonly FlagKey[]>(...keys: TKeys): TKeys {
  return keys;
}

export const SNAPSHOT_FLAGS = flagKeys(
  'snapshotInteractiveOnly',
  'snapshotDepth',
  'snapshotScope',
  'snapshotRaw',
);

export const SELECTOR_SNAPSHOT_FLAGS = flagKeys('snapshotDepth', 'snapshotScope', 'snapshotRaw');

export const METRO_PREPARE_FLAGS = flagKeys(
  'metroProjectRoot',
  'kind',
  'metroKind',
  'metroPublicBaseUrl',
  'metroProxyBaseUrl',
  'metroBearerToken',
  'metroPreparePort',
  'metroListenHost',
  'metroStatusHost',
  'metroStartupTimeoutMs',
  'metroProbeTimeoutMs',
  'metroRuntimeFile',
  'metroNoReuseExisting',
  'metroNoInstallDeps',
);

export const METRO_RELOAD_FLAGS = flagKeys('metroHost', 'metroPort', 'bundleUrl');
export const REPEATED_TOUCH_FLAGS = flagKeys(
  'count',
  'intervalMs',
  'holdMs',
  'jitterPx',
  'doubleTap',
);
export const REPLAY_FLAGS = flagKeys('replayUpdate', 'replayEnv');

const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  {
    key: 'config',
    names: ['--config'],
    type: 'string',
    usageLabel: '--config <path>',
    usageDescription: 'Load CLI defaults from a specific config file',
  },
  {
    key: 'remoteConfig',
    names: ['--remote-config'],
    type: 'string',
    usageLabel: '--remote-config <path>',
    usageDescription: 'Load remote host + Metro workflow settings from a specific profile file',
  },
  {
    key: 'stateDir',
    names: ['--state-dir'],
    type: 'string',
    usageLabel: '--state-dir <path>',
    usageDescription:
      'Daemon state directory (defaults to ~/.agent-device for packages, or a worktree-scoped dev dir from source)',
  },
  {
    key: 'daemonBaseUrl',
    names: ['--daemon-base-url'],
    type: 'string',
    usageLabel: '--daemon-base-url <url>',
    usageDescription: 'Explicit remote HTTP daemon base URL (skip local daemon discovery/startup)',
  },
  {
    key: 'daemonAuthToken',
    names: ['--daemon-auth-token'],
    type: 'string',
    usageLabel: '--daemon-auth-token <token>',
    usageDescription:
      'Remote HTTP daemon or proxy auth token (sent as request token and bearer header)',
  },
  {
    key: 'daemonTransport',
    names: ['--daemon-transport'],
    type: 'enum',
    enumValues: ['auto', 'socket', 'http'],
    usageLabel: '--daemon-transport auto|socket|http',
    usageDescription: 'Daemon client transport preference',
  },
  {
    key: 'daemonServerMode',
    names: ['--daemon-server-mode'],
    type: 'enum',
    enumValues: ['socket', 'http', 'dual'],
    usageLabel: '--daemon-server-mode socket|http|dual',
    usageDescription: 'Daemon server mode used when spawning daemon',
  },
  {
    key: 'proxyHost',
    names: ['--host'],
    type: 'string',
    usageLabel: '--host <host>',
    usageDescription: 'Proxy: host interface to bind (default: 127.0.0.1)',
  },
  {
    key: 'proxyPort',
    names: ['--port'],
    type: 'int',
    min: 1,
    max: 65535,
    usageLabel: '--port <port>',
    usageDescription: 'Proxy: TCP port to bind (default: 0, choose a free port)',
  },
  {
    key: 'tenant',
    names: ['--tenant'],
    type: 'string',
    usageLabel: '--tenant <id>',
    usageDescription: 'Tenant scope identifier for isolated daemon sessions',
  },
  {
    key: 'sessionIsolation',
    names: ['--session-isolation'],
    type: 'enum',
    enumValues: ['none', 'tenant'],
    usageLabel: '--session-isolation none|tenant',
    usageDescription: 'Session isolation strategy (tenant prefixes session namespace)',
  },
  {
    key: 'runId',
    names: ['--run-id'],
    type: 'string',
    usageLabel: '--run-id <id>',
    usageDescription: 'Run identifier used for tenant lease admission checks',
  },
  {
    key: 'leaseId',
    names: ['--lease-id'],
    type: 'string',
    usageLabel: '--lease-id <id>',
    usageDescription: 'Lease identifier bound to tenant/run admission scope',
  },
  {
    key: 'leaseBackend',
    names: ['--lease-backend'],
    type: 'enum',
    enumValues: ['ios-simulator', 'ios-instance', 'android-instance'],
    usageLabel: '--lease-backend ios-simulator|ios-instance|android-instance',
    usageDescription: 'Lease backend for remote tenant connection admission',
  },
  {
    key: 'provider',
    names: ['--provider'],
    type: 'string',
    usageLabel: '--provider <name>',
    usageDescription: 'Cloud provider name for provider-scoped commands',
  },
  {
    key: 'providerSessionId',
    names: ['--provider-session'],
    type: 'string',
    usageLabel: '--provider-session <id>',
    usageDescription: 'Cloud provider session id or ARN',
  },
  {
    key: 'providerApp',
    names: ['--provider-app'],
    type: 'string',
    usageLabel: '--provider-app <ref-or-path>',
    usageDescription:
      'Cloud provider app reference or local app path used when creating hosted WebDriver sessions',
  },
  {
    key: 'providerOsVersion',
    names: ['--provider-os-version', '--os-version'],
    type: 'string',
    usageLabel: '--provider-os-version <version>',
    usageDescription: 'Hosted cloud provider OS version, for example 17 or 14.0',
  },
  {
    key: 'providerProject',
    names: ['--provider-project'],
    type: 'string',
    usageLabel: '--provider-project <name>',
    usageDescription: 'Hosted cloud provider project label',
  },
  {
    key: 'providerBuild',
    names: ['--provider-build'],
    type: 'string',
    usageLabel: '--provider-build <name>',
    usageDescription: 'Hosted cloud provider build label',
  },
  {
    key: 'providerSessionName',
    names: ['--provider-session-name'],
    type: 'string',
    usageLabel: '--provider-session-name <name>',
    usageDescription: 'Hosted cloud provider session label',
  },
  {
    key: 'awsProjectArn',
    names: ['--aws-project-arn'],
    type: 'string',
    usageLabel: '--aws-project-arn <arn>',
    usageDescription: 'AWS Device Farm project ARN for hosted WebDriver sessions',
  },
  {
    key: 'awsDeviceArn',
    names: ['--aws-device-arn'],
    type: 'string',
    usageLabel: '--aws-device-arn <arn>',
    usageDescription: 'AWS Device Farm device ARN for hosted WebDriver sessions',
  },
  {
    key: 'awsAppArn',
    names: ['--aws-app-arn'],
    type: 'string',
    usageLabel: '--aws-app-arn <arn>',
    usageDescription: 'AWS Device Farm app ARN attached to hosted remote access sessions',
  },
  {
    key: 'awsRegion',
    names: ['--aws-region'],
    type: 'string',
    usageLabel: '--aws-region <region>',
    usageDescription: 'AWS region for Device Farm API calls',
  },
  {
    key: 'awsInteractionMode',
    names: ['--aws-interaction-mode'],
    type: 'enum',
    enumValues: ['INTERACTIVE', 'NO_VIDEO', 'VIDEO_ONLY'],
    usageLabel: '--aws-interaction-mode INTERACTIVE|NO_VIDEO|VIDEO_ONLY',
    usageDescription: 'AWS Device Farm remote access interaction mode',
  },
  {
    key: 'force',
    names: ['--force'],
    type: 'boolean',
    usageLabel: '--force',
    usageDescription: 'Force connection state replacement when reconnecting',
  },
  {
    key: 'noLogin',
    names: ['--no-login'],
    type: 'boolean',
    usageLabel: '--no-login',
    usageDescription: 'Connect: fail instead of starting implicit cloud login',
  },
  {
    key: 'sessionLock',
    names: ['--session-lock'],
    type: 'enum',
    enumValues: ['reject', 'strip'],
    usageLabel: '--session-lock reject|strip',
    usageDescription:
      'Lock bound-session device routing for this CLI invocation and nested batch steps',
  },
  {
    key: 'sessionLocked',
    names: ['--session-locked'],
    type: 'boolean',
    usageLabel: '--session-locked',
    usageDescription: 'Deprecated alias for --session-lock reject',
  },
  {
    key: 'sessionLockConflicts',
    names: ['--session-lock-conflicts'],
    type: 'enum',
    enumValues: ['reject', 'strip'],
    usageLabel: '--session-lock-conflicts reject|strip',
    usageDescription: 'Deprecated alias for --session-lock',
  },
  {
    key: 'platform',
    names: ['--platform'],
    type: 'enum',
    enumValues: PLATFORM_SELECTORS,
    usageLabel: `--platform ${PLATFORM_SELECTORS.join('|')}`,
    usageDescription: 'Platform to target (`apple` aliases the Apple automation backend)',
  },
  {
    key: 'target',
    names: ['--target'],
    type: 'enum',
    enumValues: ['mobile', 'tv', 'desktop'],
    usageLabel: '--target mobile|tv|desktop',
    usageDescription: 'Device target class to match',
  },
  {
    key: 'device',
    names: ['--device'],
    type: 'string',
    usageLabel: '--device <name>',
    usageDescription: 'Device name to target',
  },
  {
    key: 'udid',
    names: ['--udid'],
    type: 'string',
    usageLabel: '--udid <udid>',
    usageDescription: 'iOS device UDID',
  },
  {
    key: 'serial',
    names: ['--serial'],
    type: 'string',
    usageLabel: '--serial <serial>',
    usageDescription: 'Android device serial',
  },
  {
    key: 'surface',
    names: ['--surface'],
    type: 'enum',
    enumValues: SESSION_SURFACES,
    usageLabel: '--surface app|frontmost-app|desktop|menubar',
    usageDescription: 'macOS session surface for open (defaults to app)',
  },
  {
    key: 'headless',
    names: ['--headless'],
    type: 'boolean',
    usageLabel: '--headless',
    usageDescription: 'Boot: launch Android emulator without a GUI window',
  },
  {
    key: 'targetApp',
    names: ['--app', '--target-app'],
    type: 'string',
    usageLabel: '--app <id-or-name>',
    usageDescription: 'Doctor: verify an installed target app without opening a session',
  },
  {
    key: 'metroHost',
    names: ['--metro-host'],
    type: 'string',
    usageLabel: '--metro-host <host>',
    usageDescription: 'Session-scoped Metro/debug host hint',
  },
  {
    key: 'metroPort',
    names: ['--metro-port'],
    type: 'int',
    min: 1,
    max: 65535,
    usageLabel: '--metro-port <port>',
    usageDescription: 'Session-scoped Metro/debug port hint',
  },
  {
    key: 'metroProjectRoot',
    names: ['--project-root'],
    type: 'string',
    usageLabel: '--project-root <path>',
    usageDescription: 'metro prepare: React Native project root (default: cwd)',
  },
  {
    key: 'kind',
    names: ['--kind'],
    type: 'enum',
    enumValues: ['auto', 'react-native', 'expo', ...PERF_KIND_VALUES],
    usageLabel: '--kind <kind>',
    usageDescription:
      'Kind selector for commands that support it, such as metro prepare or perf artifact collectors',
  },
  {
    key: 'perfTemplate',
    names: ['--template'],
    type: 'string',
    usageLabel: '--template <name>',
    usageDescription: 'Perf xctrace template name, for example Time Profiler',
  },
  {
    key: 'metroKind',
    names: ['--metro-kind'],
    type: 'enum',
    enumValues: ['auto', 'react-native', 'expo'],
    usageLabel: '--metro-kind auto|react-native|expo',
    usageDescription: 'metro prepare: detect or force the Metro launcher kind',
  },
  {
    key: 'metroPublicBaseUrl',
    names: ['--public-base-url'],
    type: 'string',
    usageLabel: '--public-base-url <url>',
    usageDescription: 'metro prepare: public base URL used for direct bundle hints',
  },
  {
    key: 'metroProxyBaseUrl',
    names: ['--proxy-base-url'],
    type: 'string',
    usageLabel: '--proxy-base-url <url>',
    usageDescription: 'metro prepare: optional bridge origin for remote Metro access',
  },
  {
    key: 'metroBearerToken',
    names: ['--bearer-token'],
    type: 'string',
    usageLabel: '--bearer-token <token>',
    usageDescription:
      'metro prepare: host bridge bearer token (or AGENT_DEVICE_METRO_BEARER_TOKEN; falls back to AGENT_DEVICE_DAEMON_AUTH_TOKEN)',
  },
  {
    key: 'metroPreparePort',
    names: ['--port'],
    type: 'int',
    min: 1,
    max: 65535,
    usageLabel: '--port <port>',
    usageDescription: 'metro prepare: local Metro port (default: 8081)',
  },
  {
    key: 'metroListenHost',
    names: ['--listen-host'],
    type: 'string',
    usageLabel: '--listen-host <host>',
    usageDescription: 'metro prepare: host Metro listens on (default: 0.0.0.0)',
  },
  {
    key: 'metroStatusHost',
    names: ['--status-host'],
    type: 'string',
    usageLabel: '--status-host <host>',
    usageDescription: 'metro prepare: host used for local /status polling (default: 127.0.0.1)',
  },
  {
    key: 'metroStartupTimeoutMs',
    names: ['--startup-timeout-ms'],
    type: 'int',
    min: 1,
    usageLabel: '--startup-timeout-ms <ms>',
    usageDescription: 'metro prepare: timeout while waiting for Metro to become ready',
  },
  {
    key: 'metroProbeTimeoutMs',
    names: ['--probe-timeout-ms'],
    type: 'int',
    min: 1,
    usageLabel: '--probe-timeout-ms <ms>',
    usageDescription: 'metro prepare: timeout for /status and proxy bridge calls',
  },
  {
    key: 'metroRuntimeFile',
    names: ['--runtime-file'],
    type: 'string',
    usageLabel: '--runtime-file <path>',
    usageDescription: 'metro prepare: optional file path to persist the JSON result',
  },
  {
    key: 'metroNoReuseExisting',
    names: ['--no-reuse-existing'],
    type: 'boolean',
    usageLabel: '--no-reuse-existing',
    usageDescription: 'metro prepare: always start a fresh Metro process',
  },
  {
    key: 'metroNoInstallDeps',
    names: ['--no-install-deps'],
    type: 'boolean',
    usageLabel: '--no-install-deps',
    usageDescription: 'metro prepare: skip package-manager install when node_modules is missing',
  },
  {
    key: 'bundleUrl',
    names: ['--bundle-url'],
    type: 'string',
    usageLabel: '--bundle-url <url>',
    usageDescription: 'Session-scoped bundle URL hint',
  },
  {
    key: 'launchUrl',
    names: ['--launch-url'],
    type: 'string',
    usageLabel: '--launch-url <url>',
    usageDescription: 'Session-scoped deep link / launch URL hint',
  },
  {
    key: 'iosSimulatorDeviceSet',
    names: ['--ios-simulator-device-set'],
    type: 'string',
    usageLabel: '--ios-simulator-device-set <path>',
    usageDescription: 'Scope iOS simulator discovery/commands to this simulator device set',
  },
  {
    key: 'iosXctestrunFile',
    names: ['--ios-xctestrun-file'],
    type: 'string',
    usageLabel: '--ios-xctestrun-file <path>',
    usageDescription: 'Use an externally built iOS XCTest runner .xctestrun artifact',
  },
  {
    key: 'iosXctestDerivedDataPath',
    names: ['--ios-xctest-derived-data-path'],
    type: 'string',
    usageLabel: '--ios-xctest-derived-data-path <path>',
    usageDescription: 'Derived data path for external iOS XCTest runner execution',
  },
  {
    key: 'iosXctestEnvDir',
    names: ['--ios-xctest-env-dir'],
    type: 'string',
    usageLabel: '--ios-xctest-env-dir <path>',
    usageDescription: 'Writable directory for per-session iOS XCTest runner env overlays',
  },
  {
    key: 'deviceHub',
    names: ['--device-hub'],
    type: 'boolean',
    usageLabel: '--device-hub',
    usageDescription: 'open: use Xcode Device Hub when surfacing Apple simulators',
  },
  {
    key: 'androidDeviceAllowlist',
    names: ['--android-device-allowlist'],
    type: 'string',
    usageLabel: '--android-device-allowlist <serials>',
    usageDescription: 'Comma/space separated Android serial allowlist for discovery/selection',
  },
  {
    key: 'remote',
    names: ['--remote'],
    type: 'boolean',
    usageLabel: '--remote',
    usageDescription: 'Doctor: check remote connection setup instead of local device inventory',
  },
  {
    key: 'activity',
    names: ['--activity'],
    type: 'string',
    usageLabel: '--activity <component>',
    usageDescription: 'Android app launch activity (package/Activity); not for URL opens',
  },
  {
    key: 'launchConsole',
    names: ['--launch-console'],
    type: 'string',
    usageLabel: '--launch-console <path>',
    usageDescription: 'open: capture the initial iOS simulator launch console window to a file',
  },
  {
    key: 'launchArgs',
    names: ['--launch-args'],
    type: 'string',
    multiple: true,
    usageLabel: '--launch-args <arg>',
    usageDescription:
      'open: repeatable launch argument forwarded verbatim to the platform launch command (iOS app process args; Android adb shell am start args). Linux and macOS reject the flag.',
  },
  {
    key: 'header',
    names: ['--header'],
    type: 'string',
    multiple: true,
    usageLabel: '--header <name:value>',
    usageDescription: 'install-from-source: repeatable HTTP header for URL downloads',
  },
  {
    key: 'githubActionsArtifact',
    names: ['--github-actions-artifact'],
    type: 'string',
    usageLabel: '--github-actions-artifact <owner/repo:artifact>',
    usageDescription: 'install-from-source: GitHub Actions artifact resolved by a remote daemon',
  },
  {
    key: 'installSource',
    // Config-only virtual option; parsed explicitly from JSON before generic string options.
    names: [],
    type: 'string',
  },
  {
    key: 'session',
    names: ['--session'],
    type: 'string',
    usageLabel: '--session <name>',
    usageDescription: 'Named session',
  },
  {
    key: 'count',
    names: ['--count'],
    type: 'int',
    min: 1,
    max: 200,
    usageLabel: '--count <n>',
    usageDescription: 'Repeat count for press/swipe series',
  },
  {
    key: 'fps',
    names: ['--fps'],
    type: 'int',
    min: 1,
    max: 120,
    usageLabel: '--fps <n>',
    usageDescription: 'Record: target frames per second (iOS physical device runner)',
  },
  {
    key: 'quality',
    names: ['--quality'],
    type: 'string',
    usageLabel: '--quality <medium|high>',
    usageDescription:
      'Record: output quality preset; Android maps this to screenrecord bitrate, Apple targets use it for export/encoding. Legacy numeric values 5-7 map to medium; 8-10 map to high',
  },
  {
    key: 'hideTouches',
    names: ['--hide-touches'],
    type: 'boolean',
    usageLabel: '--hide-touches',
    usageDescription: 'Record: skip touch-overlay post-processing for faster raw benchmark videos',
  },
  {
    key: 'intervalMs',
    names: ['--interval-ms'],
    type: 'int',
    min: 0,
    max: 10_000,
    usageLabel: '--interval-ms <ms>',
    usageDescription: 'Delay between press iterations',
  },
  {
    key: 'delayMs',
    names: ['--delay-ms'],
    type: 'int',
    min: 0,
    max: 10_000,
    usageLabel: '--delay-ms <ms>',
    usageDescription: 'Delay between typed characters',
  },
  {
    key: 'durationMs',
    names: ['--duration-ms'],
    type: 'int',
    min: 0,
    max: 10_000,
    usageLabel: '--duration-ms <ms>',
    usageDescription: 'Scroll: pace the gesture over this duration when supported',
  },
  {
    key: 'holdMs',
    names: ['--hold-ms'],
    type: 'int',
    min: 0,
    max: 10_000,
    usageLabel: '--hold-ms <ms>',
    usageDescription: 'Press hold duration for each iteration',
  },
  {
    key: 'jitterPx',
    names: ['--jitter-px'],
    type: 'int',
    min: 0,
    max: 100,
    usageLabel: '--jitter-px <n>',
    usageDescription: 'Deterministic coordinate jitter radius for press',
  },
  {
    key: 'pixels',
    names: ['--pixels'],
    type: 'int',
    min: 1,
    max: 100_000,
    usageLabel: '--pixels <n>',
    usageDescription: 'Scroll: explicit gesture distance in pixels',
  },
  {
    key: 'doubleTap',
    names: ['--double-tap'],
    type: 'boolean',
    usageLabel: '--double-tap',
    usageDescription: 'Use double-tap gesture per press iteration',
  },
  {
    key: 'clickButton',
    names: ['--button'],
    type: 'enum',
    enumValues: ['primary', 'secondary', 'middle'],
    usageLabel: '--button primary|secondary|middle',
    usageDescription: 'Click: choose mouse button (middle reserved for future macOS support)',
  },
  // These aliases encode the value directly in the flag name so `back` reads naturally as
  // `back --in-app` or `back --system` without introducing a separate `--back-mode` flag.
  {
    key: 'backMode',
    names: ['--in-app'],
    type: 'enum',
    enumValues: ['in-app', 'system'],
    setValue: 'in-app',
    usageLabel: '--in-app',
    usageDescription: 'Back: use app-provided back UI when available',
  },
  {
    key: 'backMode',
    names: ['--system'],
    type: 'enum',
    enumValues: ['in-app', 'system'],
    setValue: 'system',
    usageLabel: '--system',
    usageDescription: 'Back: use system back input or gesture when available',
  },
  {
    key: 'pauseMs',
    names: ['--pause-ms'],
    type: 'int',
    min: 0,
    max: 10_000,
    usageLabel: '--pause-ms <ms>',
    usageDescription: 'Delay between swipe iterations',
  },
  {
    key: 'pattern',
    names: ['--pattern'],
    type: 'enum',
    enumValues: ['one-way', 'ping-pong'],
    usageLabel: '--pattern one-way|ping-pong',
    usageDescription: 'Swipe repeat pattern',
  },
  {
    key: 'verbose',
    names: ['--debug', '--verbose', '-v'],
    type: 'boolean',
    usageLabel: '--debug, --verbose, -v',
    usageDescription:
      'Enable debug diagnostics; test --verbose prints per-test step timings without debug logs',
  },
  {
    key: 'cost',
    names: ['--cost'],
    type: 'boolean',
    usageLabel: '--cost',
    usageDescription: 'Include per-command wall-clock latency (cost.wallClockMs) in the response',
  },
  {
    key: 'responseLevel',
    names: ['--level'],
    type: 'enum',
    enumValues: RESPONSE_LEVELS,
    usageLabel: '--level digest|default|full',
    usageDescription:
      'Response detail level: digest (token-cheap), default (today), or full. Default keeps the wire shape unchanged.',
  },
  {
    key: 'json',
    names: ['--json'],
    type: 'boolean',
    usageLabel: '--json',
    usageDescription: 'JSON output',
  },
  {
    key: 'help',
    names: ['--help', '-h'],
    type: 'boolean',
    usageLabel: '--help, -h',
    usageDescription: 'Print help and exit',
  },
  {
    key: 'version',
    names: ['--version', '-V'],
    type: 'boolean',
    usageLabel: '--version, -V',
    usageDescription: 'Print version and exit',
  },
  {
    key: 'snapshotDiff',
    names: ['--diff'],
    type: 'boolean',
    usageLabel: '--diff',
    usageDescription: 'Snapshot: show structural diff against the previous session baseline',
  },
  {
    key: 'saveScript',
    names: ['--save-script'],
    type: 'booleanOrString',
    usageLabel: '--save-script [path]',
    usageDescription: 'Save session script (.ad) on close; optional custom output path',
  },
  {
    key: 'networkInclude',
    names: ['--include'],
    type: 'enum',
    enumValues: ['summary', 'headers', 'body', 'all'],
    usageLabel: '--include summary|headers|body|all',
    usageDescription: 'Network: include headers, bodies, or both in output',
  },
  {
    key: 'shutdown',
    names: ['--shutdown'],
    type: 'boolean',
    usageLabel: '--shutdown',
    usageDescription: 'close: shutdown associated simulator/emulator after ending session',
  },
  {
    key: 'relaunch',
    names: ['--relaunch'],
    type: 'boolean',
    usageLabel: '--relaunch',
    usageDescription: 'open: terminate app process before launching it',
  },
  {
    key: 'restart',
    names: ['--restart'],
    type: 'boolean',
    usageLabel: '--restart',
    usageDescription: 'logs clear: stop active stream, clear logs, then start streaming again',
  },
  {
    key: 'retainPaths',
    names: ['--retain-paths'],
    type: 'boolean',
    usageLabel: '--retain-paths',
    usageDescription: 'install-from-source: keep materialized artifact paths after install',
  },
  {
    key: 'retentionMs',
    names: ['--retention-ms'],
    type: 'int',
    min: 1,
    usageLabel: '--retention-ms <ms>',
    usageDescription: 'install-from-source: retention TTL for materialized artifact paths',
  },
  {
    key: 'noRecord',
    names: ['--no-record'],
    type: 'boolean',
    usageLabel: '--no-record',
    usageDescription: 'Do not record this action',
  },
  {
    key: 'replayUpdate',
    names: ['--update', '-u'],
    type: 'boolean',
    usageLabel: '--update, -u',
    usageDescription: 'Replay: update selectors and rewrite replay file in place',
  },
  {
    key: 'replayMaestro',
    names: ['--maestro'],
    type: 'boolean',
    usageLabel: '--maestro',
    usageDescription:
      `Replay: treat input as a Maestro YAML compatibility flow. ${formatMaestroSupportedSubsetForCli()} ` +
      `Unsupported syntax fails loudly with a link to ${MAESTRO_COMPAT_TRACKER_URL}`,
  },
  {
    key: 'replayExportFormat',
    names: ['--format'],
    type: 'enum',
    enumValues: ['maestro'],
    usageLabel: '--format maestro',
    usageDescription: 'Replay export: output format',
  },
  {
    key: 'replayEnv',
    names: ['-e', '--env'],
    type: 'string',
    multiple: true,
    usageLabel: '-e KEY=VALUE, --env KEY=VALUE',
    usageDescription:
      'Replay/Test: inject or override a ${KEY} variable for the script (repeatable)',
  },
  {
    key: 'failFast',
    names: ['--fail-fast'],
    type: 'boolean',
    usageLabel: '--fail-fast',
    usageDescription:
      'Test: stop the suite after the first failing script; with sharding, each shard stops independently',
  },
  {
    key: 'timeoutMs',
    names: ['--timeout'],
    type: 'int',
    min: 1,
    usageLabel: '--timeout <ms>',
    usageDescription:
      'Prepare/Replay/Snapshot/Test: maximum wall-clock time for the command or attempt',
  },
  {
    key: 'retries',
    names: ['--retries'],
    type: 'int',
    min: 0,
    max: 3,
    usageLabel: '--retries <n>',
    usageDescription: 'Test: retry each failed script up to n additional times',
  },
  {
    key: 'recordVideo',
    names: ['--record-video'],
    type: 'boolean',
    usageLabel: '--record-video',
    usageDescription: 'Test: record each replay attempt to recording.mp4 in its attempt artifacts',
  },
  {
    key: 'artifactsDir',
    names: ['--artifacts-dir'],
    type: 'string',
    usageLabel: '--artifacts-dir <path>',
    usageDescription: 'Test: root directory for suite artifacts',
  },
  {
    key: 'reporter',
    names: ['--reporter'],
    type: 'string',
    multiple: true,
    usageLabel: '--reporter <name-or-path>',
    usageDescription:
      'Test: add a replay suite reporter; use default, junit:<path>, or a custom reporter path (repeatable)',
  },
  {
    key: 'reportJunit',
    names: ['--report-junit'],
    type: 'string',
    usageLabel: '--report-junit <path>',
    usageDescription: 'Test: compatibility alias for --reporter junit:<path>',
  },
  {
    key: 'shardAll',
    names: ['--shard-all'],
    type: 'int',
    min: 1,
    usageLabel: '--shard-all <n>',
    usageDescription:
      'Test: run the full suite on each of n devices; combine with --device id1,id2 for explicit connected devices; AD_SHARD_INDEX is zero-based',
  },
  {
    key: 'shardSplit',
    names: ['--shard-split'],
    type: 'int',
    min: 1,
    usageLabel: '--shard-split <n>',
    usageDescription:
      'Test: split runnable suite entries across n devices; AD_SHARD_INDEX is zero-based',
  },
  {
    key: 'steps',
    names: ['--steps'],
    type: 'string',
    usageLabel: '--steps <json>',
    usageDescription: 'Batch: JSON array of steps',
  },
  {
    key: 'stepsFile',
    names: ['--steps-file'],
    type: 'string',
    usageLabel: '--steps-file <path>',
    usageDescription: 'Batch: read steps JSON from file',
  },
  {
    key: 'batchOnError',
    names: ['--on-error'],
    type: 'enum',
    enumValues: ['stop'],
    usageLabel: '--on-error stop',
    usageDescription: 'Batch: stop when a step fails',
  },
  {
    key: 'batchMaxSteps',
    names: ['--max-steps'],
    type: 'int',
    min: 1,
    max: 1000,
    usageLabel: '--max-steps <n>',
    usageDescription: 'Batch: maximum number of allowed steps',
  },
  {
    key: 'appsFilter',
    names: ['--all'],
    type: 'enum',
    enumValues: ['user-installed', 'all'],
    setValue: 'all',
    usageLabel: '--all',
    usageDescription: 'Apps: include system/OEM apps',
  },
  {
    key: 'snapshotInteractiveOnly',
    names: ['-i'],
    type: 'boolean',
    usageLabel: '-i',
    usageDescription: 'Snapshot: interactive elements only',
  },
  {
    key: 'snapshotDepth',
    names: ['--depth', '-d'],
    type: 'int',
    min: 0,
    usageLabel: '--depth, -d <depth>',
    usageDescription: 'Snapshot: limit snapshot depth',
  },
  {
    key: 'snapshotScope',
    names: ['--scope', '-s'],
    type: 'string',
    usageLabel: '--scope, -s <scope>',
    usageDescription: 'Snapshot: scope snapshot to label/identifier',
  },
  {
    key: 'snapshotRaw',
    names: ['--raw'],
    type: 'boolean',
    usageLabel: '--raw',
    usageDescription: 'Snapshot: raw node output',
  },
  {
    key: 'snapshotForceFull',
    names: ['--force-full'],
    type: 'boolean',
    usageLabel: '--force-full',
    usageDescription: 'Snapshot: re-emit the full tree even when unchanged',
  },
  {
    key: 'findFirst',
    names: ['--first'],
    type: 'boolean',
    usageLabel: '--first',
    usageDescription: 'Find: pick the first match when ambiguous',
  },
  {
    key: 'findLast',
    names: ['--last'],
    type: 'boolean',
    usageLabel: '--last',
    usageDescription: 'Find: pick the last match when ambiguous',
  },
  {
    key: 'out',
    names: ['--out'],
    type: 'string',
    usageLabel: '--out <path>',
    usageDescription: 'Output path',
  },
  {
    key: 'artifact',
    names: ['--artifact'],
    type: 'string',
    usageLabel: '--artifact <path>',
    usageDescription: 'Debug symbols: Apple crash artifact path (.ips, .crash, or .log)',
  },
  {
    key: 'dsym',
    names: ['--dsym'],
    type: 'string',
    usageLabel: '--dsym <path>',
    usageDescription: 'Debug symbols: matching .dSYM bundle path',
  },
  {
    key: 'searchPath',
    names: ['--search-path'],
    type: 'string',
    usageLabel: '--search-path <dir>',
    usageDescription: 'Debug symbols: directory to scan for matching .dSYM bundles',
  },
  {
    key: 'overlayRefs',
    names: ['--overlay-refs'],
    type: 'boolean',
    usageLabel: '--overlay-refs',
    usageDescription:
      'Screenshot: draw current snapshot refs and target rectangles onto the saved PNG; diff screenshot: also write a separate current-screen overlay guide',
  },
  ...SCREENSHOT_SPECIFIC_FLAG_DEFINITIONS,
  {
    key: 'baseline',
    names: ['--baseline', '-b'],
    type: 'string',
    usageLabel: '--baseline, -b <path>',
    usageDescription: 'Diff screenshot: path to baseline image file',
  },
  {
    key: 'threshold',
    names: ['--threshold'],
    type: 'string',
    usageLabel: '--threshold <0-1>',
    usageDescription: 'Diff screenshot: color distance threshold (default 0.1)',
  },
];

export const COMMON_COMMAND_SUPPORTED_FLAG_KEYS = flagKeys(
  'remoteConfig',
  'stateDir',
  'daemonBaseUrl',
  'daemonAuthToken',
  'daemonTransport',
  'daemonServerMode',
  'tenant',
  'sessionIsolation',
  'runId',
  'leaseId',
  'leaseBackend',
  'sessionLock',
  'sessionLocked',
  'sessionLockConflicts',
  'platform',
  'target',
  'device',
  'providerApp',
  'providerOsVersion',
  'providerProject',
  'providerBuild',
  'providerSessionName',
  'awsProjectArn',
  'awsDeviceArn',
  'awsAppArn',
  'awsRegion',
  'awsInteractionMode',
  'udid',
  'serial',
  'iosSimulatorDeviceSet',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'androidDeviceAllowlist',
  'session',
  'noRecord',
);

export const GLOBAL_FLAG_KEYS = new Set<FlagKey>([
  'json',
  'config',
  'help',
  'version',
  'verbose',
  'cost',
  'responseLevel',
]);

const flagDefinitionByName = new Map<string, FlagDefinition>();
for (const definition of FLAG_DEFINITIONS) {
  for (const name of definition.names) {
    flagDefinitionByName.set(name, definition);
  }
}

export function getFlagDefinition(token: string): FlagDefinition | undefined {
  return flagDefinitionByName.get(token);
}

export function getFlagDefinitions(): readonly FlagDefinition[] {
  return FLAG_DEFINITIONS;
}
