import type { CliFlags, DaemonExcludedCliFlag } from '../contracts/cli-flags.ts';
import type { ScreenshotDispatchFlags } from '../contracts/screenshot.ts';
import type { DaemonBatchStep } from './batch.ts';
import type { BackMode } from '../contracts/back-mode.ts';
import type { ClickButton } from './click-button.ts';
import type { ElementSelectorKey } from './interactor-types.ts';
import type { SwipePattern } from '../contracts/scroll-gesture.ts';
import type { SessionSurface } from '../contracts/session-surface.ts';
import type { RunnerLogicalLeaseContext } from './runner-lease-context.ts';
import type { Point } from '../kernel/snapshot.ts';

export type MaestroRuntimeFlags = {
  allowNonHittableCoordinateFallback?: boolean;
  expectedTapPoint?: Point;
  prewarmRunnerBeforeOpen?: boolean;
  screenshotCaptureBackend?: 'runner';
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
  // iOS simulator only: relaunch via a single `simctl launch
  // --terminate-running-process` instead of a separate terminate + launch.
  terminateRunningApp?: boolean;
  clearAppState?: boolean;
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
  runnerLeaseContext?: RunnerLogicalLeaseContext;
  screenshotCaptureBackend?: 'runner';
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
    expectedPoint?: Point;
  };
};
