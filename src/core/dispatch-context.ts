// CommandFlags and MaestroRuntimeFlags are declared in contracts/ so both sides of the process
// boundary can be stated in terms of them; re-exported here because this is where consumers
// already import them from.
import type { ScreenshotDispatchFlags } from '@agent-device/contracts/capture';
import type { BackMode } from '@agent-device/contracts/back-mode';
import type { ClickButton } from '@agent-device/contracts/click-button';
import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { SwipePattern } from '@agent-device/contracts/scroll-gesture';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { Point, SnapshotPreferredBackend } from '@agent-device/kernel/snapshot';

export type DispatchContext = ScreenshotDispatchFlags & {
  requestId?: string;
  signal?: AbortSignal;
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
  snapshotPreferredBackend?: SnapshotPreferredBackend;
  snapshotDepth?: number;
  snapshotScope?: string;
  snapshotRaw?: boolean;
  snapshotCustomActions?: boolean;
  snapshotIncludeRects?: boolean;
  snapshotIncludeHiddenContentHints?: boolean;
  skipIosSimulatorBootCheck?: boolean;
  count?: number;
  intervalMs?: number;
  delayMs?: number;
  /** Maestro replay compatibility for coordinate-resolved fill targets. */
  allowNonHittableCoordinateFallback?: boolean;
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
