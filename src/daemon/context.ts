import type { CommandFlags, DispatchContext } from '../core/dispatch-context.ts';
import { resolveClickButton } from '../core/click-button.ts';
import {
  screenshotFlagsFromOptions,
  type ScreenshotRuntimeFlags,
} from '../contracts/screenshot.ts';
import { getDiagnosticsMeta } from '../utils/diagnostics.ts';
import { resolveRunnerLogicalLeaseContext } from './lease-context.ts';
import type { DaemonRequest } from './types.ts';

export type DaemonCommandContext = DispatchContext & ScreenshotRuntimeFlags;

// Flat compatibility mapper: keeping each CLI flag visible here makes request
// context drift easier to spot than splitting the same optional fields apart.
// fallow-ignore-next-line complexity
export function contextFromFlags(
  logPath: string,
  flags: CommandFlags | undefined,
  appBundleId?: string,
  traceLogPath?: string,
  requestId?: string,
  meta?: DaemonRequest['meta'],
): DaemonCommandContext {
  const effectiveRequestId = requestId ?? getDiagnosticsMeta().requestId;
  return {
    requestId: effectiveRequestId,
    appBundleId,
    runnerLeaseContext: resolveRunnerLogicalLeaseContext({ meta }),
    activity: flags?.activity,
    launchConsole: flags?.launchConsole,
    launchArgs: flags?.launchArgs,
    clearAppState: flags?.clearAppState,
    verbose: flags?.verbose,
    logPath,
    traceLogPath,
    iosXctestrunFile: flags?.iosXctestrunFile,
    iosXctestDerivedDataPath: flags?.iosXctestDerivedDataPath,
    iosXctestEnvDir: flags?.iosXctestEnvDir,
    snapshotInteractiveOnly: flags?.snapshotInteractiveOnly,
    snapshotDepth: flags?.snapshotDepth,
    snapshotScope: flags?.snapshotScope,
    snapshotRaw: flags?.snapshotRaw,
    ...screenshotFlagsFromOptions(flags),
    count: flags?.count,
    intervalMs: flags?.intervalMs,
    delayMs: flags?.delayMs,
    durationMs: flags?.durationMs,
    holdMs: flags?.holdMs,
    jitterPx: flags?.jitterPx,
    pixels: flags?.pixels,
    doubleTap: flags?.doubleTap,
    clickButton: resolveClickButton(flags),
    backMode: flags?.backMode,
    pauseMs: flags?.pauseMs,
    pattern: flags?.pattern,
  };
}
