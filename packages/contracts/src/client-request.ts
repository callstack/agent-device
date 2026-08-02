// The public API vocabulary for the internal request envelope every client call is projected into.

import type { AppsFilter } from './app-inventory.ts';
import type { BackMode } from './back-mode.ts';
import type { ClickButton } from './click-button.ts';
import type { RecordingExportQuality } from './recording-export-quality.ts';
import type { RecordingScope } from './recording-scope.ts';
import type { ScreenshotRequestFlags } from './screenshot.ts';
import type { SwipePattern } from './scroll-gesture.ts';
import type { SessionSurface } from './session-surface.ts';
import type {
  DaemonInstallSource,
  DaemonResponseData,
  NetworkIncludeMode,
  SessionRuntimeHints,
} from '@agent-device/kernel/contracts';
import type { DaemonBatchStep } from './batch-step.ts';
import type { AgentDeviceClientConfig, AgentDeviceSelectionOptions } from './client-connection.ts';

export type CommandExecutionOptions = Partial<ScreenshotRequestFlags> & {
  positionals?: string[];
  kind?: string;
  out?: string;
  artifact?: string;
  dsym?: string;
  searchPath?: string;
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  forceFull?: boolean;
  count?: number;
  fps?: number;
  maxSize?: number;
  recordingScope?: RecordingScope;
  quality?: RecordingExportQuality;
  hideTouches?: boolean;
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
  pauseMs?: number;
  pattern?: SwipePattern;
  headless?: boolean;
  restart?: boolean;
  replayUpdate?: boolean;
  replayBackend?: string;
  replayEnv?: string[];
  replayShellEnv?: Record<string, string>;
  replayFrom?: number;
  replayPlanDigest?: string;
  replayKeepSession?: boolean;
  failFast?: boolean;
  timeoutMs?: number;
  retries?: number;
  recordVideo?: boolean;
  artifactsDir?: string;
  shardAll?: number;
  shardSplit?: number;
  findFirst?: boolean;
  findLast?: boolean;
  networkInclude?: NetworkIncludeMode;
  batchOnError?: 'stop';
  batchMaxSteps?: number;
  batchSteps?: DaemonBatchStep[];
};

export type InternalRequestOptions = AgentDeviceClientConfig &
  AgentDeviceSelectionOptions &
  CommandExecutionOptions & {
    runtime?: SessionRuntimeHints;
    overlayRefs?: boolean;
    surface?: SessionSurface;
    activity?: string;
    launchConsole?: string;
    launchArgs?: string[];
    relaunch?: boolean;
    shutdown?: boolean;
    saveScript?: boolean | string;
    /** #1258: overwrite an existing --save-script target instead of refusing. Alias: --overwrite. */
    force?: boolean;
    deviceHub?: boolean;
    testIme?: boolean;
    noRecord?: boolean;
    /** Fill-only script parameter name used to publish `${VAR}` instead of literal text. */
    recordAs?: string;
    /** #1271 stage 2: force-record this action; mutually exclusive with `noRecord`. */
    record?: boolean;
    backMode?: BackMode;
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
    appsFilter?: AppsFilter;
    installSource?: DaemonInstallSource;
    retainMaterializedPaths?: boolean;
    materializedPathRetentionMs?: number;
    materializationId?: string;
    leaseTtlMs?: number;
    provider?: string;
    providerSessionId?: string;
  };

export type CommandRequestResult = DaemonResponseData;
