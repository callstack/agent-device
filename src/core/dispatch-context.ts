import type { CliFlags, DaemonExcludedCliFlag } from '../utils/cli-flags.ts';
import type { ScreenshotDispatchFlags } from '../contracts/screenshot.ts';
import type { DaemonBatchStep } from './batch.ts';
import type { BackMode } from './back-mode.ts';
import type { ClickButton } from './click-button.ts';
import type { ElementSelectorKey } from './interactor-types.ts';
import type { SwipePattern } from './scroll-gesture.ts';
import type { SessionSurface } from './session-surface.ts';
import type { RunnerLogicalLeaseContext } from './runner-lease-context.ts';

export type MaestroRuntimeFlags = {
  allowNonHittableCoordinateFallback?: boolean;
  allowAlreadyPastLoading?: boolean;
  optional?: boolean;
  prewarmRunnerBeforeOpen?: boolean;
  runScriptEnv?: Record<string, string>;
};

export type CommandFlags = Omit<CliFlags, DaemonExcludedCliFlag> & {
  batchSteps?: DaemonBatchStep[];
  clearAppState?: boolean;
  interactionOutcome?: {
    retryOnNoChange?: boolean;
  };
  launchArgs?: string[];
  kind?: string;
  maestro?: MaestroRuntimeFlags;
  postGestureStabilization?: boolean;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
  devicePort?: number;
  hostPort?: number;
  portReverseName?: string;
  replayBackend?: string;
  shardCount?: number;
  shardIndex?: number;
};

export type DispatchContext = ScreenshotDispatchFlags & {
  requestId?: string;
  appBundleId?: string;
  activity?: string;
  launchConsole?: string;
  launchArgs?: string[];
  clearAppState?: boolean;
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
  runnerLeaseContext?: RunnerLogicalLeaseContext;
  snapshotInteractiveOnly?: boolean;
  snapshotDepth?: number;
  snapshotScope?: string;
  snapshotRaw?: boolean;
  snapshotIncludeRects?: boolean;
  skipIosSimulatorBootCheck?: boolean;
  count?: number;
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
  surface?: SessionSurface;
  directElementSelector?: {
    key: ElementSelectorKey;
    value: string;
    raw: string;
    allowNonHittableCoordinateFallback?: boolean;
  };
};
