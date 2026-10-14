// CommandFlags and MaestroRuntimeFlags are declared in contracts/ so both sides of the process
// boundary can be stated in terms of them; re-exported here because this is where consumers
// already import them from.
import type { ScreenshotDispatchFlags } from '@agent-device/contracts/capture';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { ClickButton } from '@agent-device/contracts/click-button';
import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { Point } from '@agent-device/kernel/snapshot';

/**
 * The command flags a dispatched request carries into platform execution
 * UNCHANGED: same key, same type, no decision on the way through.
 *
 * Every key here used to be written out twice — once as a field on
 * {@link DispatchContext} and once as `key: flags?.key` in the daemon's flat
 * mapper (`contextFromFlags`) — so an identically-named flag cost two more
 * files, and a missed copy dropped it silently at the seam. Neither copy stated
 * anything this list does not.
 *
 * The flags that DO change on the way through stay hand-written at the mapper,
 * where the decision lives: `clickButton` (resolved from several flags), the
 * screenshot family (`screenshotFlagsFromOptions`), and the maestro-nested
 * capture backend. Order follows the flag order in `CliFlags`.
 */
// Exported only because `DispatchContextFlags` says `typeof` it.
// fallow-ignore-next-line unused-export
export const DISPATCH_CONTEXT_FLAG_KEYS = [
  'activity',
  'launchConsole',
  'launchArgs',
  'clearAppState',
  'verbose',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'snapshotInteractiveOnly',
  'snapshotPreferredBackend',
  'snapshotDepth',
  'snapshotScope',
  'snapshotRaw',
  'snapshotCustomActions',
  'snapshotIncludeHiddenContentHints',
  'count',
  'intervalMs',
  'delayMs',
  'durationMs',
  'holdMs',
  'jitterPx',
  'pixels',
  'until',
  'doubleTap',
  'backMode',
  'pauseMs',
  'pattern',
] as const satisfies readonly (keyof CommandFlags)[];

/** The dispatch-context view of {@link DISPATCH_CONTEXT_FLAG_KEYS}. */
export type DispatchContextFlags = Pick<CommandFlags, (typeof DISPATCH_CONTEXT_FLAG_KEYS)[number]>;

/**
 * Copies exactly the declared pass-through flags. Every key is present
 * (possibly `undefined`), matching what the hand-written mapper produced.
 */
export function dispatchContextFlags(flags: CommandFlags | undefined): DispatchContextFlags {
  return Object.fromEntries(
    DISPATCH_CONTEXT_FLAG_KEYS.map((key) => [key, flags?.[key]]),
  ) as DispatchContextFlags;
}

// `DispatchContextFlags` carries every flag that reaches platform execution
// unchanged; only the fields BELOW are context-owned — set by the request scope
// rather than copied off a flag, or a flag that a decision changed on the way.
export type DispatchContext = ScreenshotDispatchFlags &
  DispatchContextFlags & {
    requestId?: string;
    signal?: AbortSignal;
    appBundleId?: string;
    // iOS simulator only: terminate the current app inside the platform open,
    // either during `simctl launch` or immediately before `simctl openurl`.
    terminateRunningApp?: boolean;
    logPath?: string;
    traceLogPath?: string;
    runnerLeaseContext?: RunnerLogicalLeaseContext;
    screenshotCaptureBackend?: 'runner';
    snapshotIncludeRects?: boolean;
    skipIosSimulatorBootCheck?: boolean;
    /** Maestro replay compatibility for coordinate-resolved fill targets. */
    allowNonHittableCoordinateFallback?: boolean;
    clickButton?: ClickButton;
    surface?: SessionSurface;
    directElementSelector?: {
      key: ElementSelectorKey;
      value: string;
      raw: string;
      allowNonHittableCoordinateFallback?: boolean;
      expectedPoint?: Point;
    };
  };
