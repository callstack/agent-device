import type { CommandFlags } from '@agent-device/contracts/command';
import { dispatchContextFlags, type DispatchContext } from './dispatch-context.ts';
import { resolveClickButton } from '@agent-device/contracts/click-button';
import {
  screenshotFlagsFromOptions,
  type ScreenshotRuntimeFlags,
} from '@agent-device/contracts/capture';
import { getDiagnosticsMeta } from '@agent-device/host-kit/diagnostics';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { resolveRunnerLogicalLeaseContext } from './lease-context.ts';
import type { DaemonRequest } from './daemon-request.ts';

export type DaemonCommandContext = DispatchContext & ScreenshotRuntimeFlags;

export type BoundContextFromFlags = (
  flags: CommandFlags | undefined,
  appBundleId?: string,
  traceLogPath?: string,
) => DaemonCommandContext;

/**
 * The directory a relative path argument of this request resolves against: the caller's cwd, or
 * the daemon's own cwd when the client sent none. One daemon serves several workspaces. The RPC
 * schema validates `meta` only as an object, so a non-string `cwd` falls back to the daemon's.
 */
export function requestCwd(
  req: Pick<DaemonRequest, 'meta'>,
  host: Readonly<{ cwd: string }>,
): string {
  const cwd: unknown = req.meta?.cwd;
  return typeof cwd === 'string' ? cwd : host.cwd;
}

// The pass-through flags come from their one declaration
// (`DISPATCH_CONTEXT_FLAG_KEYS`); what stays written out here is what this
// mapper actually decides — the request-scope fields, and the three flag
// families that change vocabulary on the way through.
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
    signal: getRequestSignal(effectiveRequestId),
    appBundleId,
    runnerLeaseContext: resolveRunnerLogicalLeaseContext({ meta }),
    logPath,
    traceLogPath,
    ...dispatchContextFlags(flags),
    preferredScreenshotCaptureBackend: flags?.maestro?.screenshotCaptureBackend,
    ...screenshotFlagsFromOptions(flags),
    clickButton: resolveClickButton(flags),
  };
}
