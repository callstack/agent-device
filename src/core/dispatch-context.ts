// CommandFlags and MaestroRuntimeFlags are declared in contracts/ so both sides of the process
// boundary can be stated in terms of them; re-exported here because this is where consumers
// already import them from.
export type { CommandFlags } from '../contracts/command-flags.ts';
import type { ScreenshotDispatchFlags } from '../contracts/screenshot.ts';
import type { BackMode } from '../contracts/back-mode.ts';
import type { ClickButton } from '../contracts/click-button.ts';
import type { ElementSelectorKey } from '../contracts/interactor-types.ts';
import type { SwipePattern } from '../contracts/scroll-gesture.ts';
import type { SessionSurface } from '../contracts/session-surface.ts';
import type { RunnerLogicalLeaseContext } from '../contracts/runner-lease-context.ts';
import type { Point } from '../kernel/snapshot.ts';

export type DispatchContext = ScreenshotDispatchFlags & {
  requestId?: string;
  appBundleId?: string;
  activity?: string;
  launchConsole?: string;
  launchArgs?: string[];
  // iOS simulator only: terminate the current app inside the platform open,
  // either during `simctl launch` or immediately before `simctl openurl`.
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
  snapshotIncludeHiddenContentHints?: boolean;
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
