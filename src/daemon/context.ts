import type { CommandFlags } from '@agent-device/contracts/command';
import { dispatchContextFlags, type DispatchContext } from '../core/dispatch-context.ts';
import { resolveClickButton } from '@agent-device/contracts/click-button';
import {
  screenshotFlagsFromOptions,
  type ScreenshotRuntimeFlags,
} from '@agent-device/contracts/capture';
import { getDiagnosticsMeta } from '@agent-device/host-kit/diagnostics';
import { resolveRunnerLogicalLeaseContext } from './lease-context.ts';
import type { DaemonRequest } from './daemon-request.ts';

export type DaemonCommandContext = DispatchContext & ScreenshotRuntimeFlags;

export type BoundContextFromFlags = (
  flags: CommandFlags | undefined,
  appBundleId?: string,
  traceLogPath?: string,
) => DaemonCommandContext;

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
    appBundleId,
    runnerLeaseContext: resolveRunnerLogicalLeaseContext({ meta }),
    logPath,
    traceLogPath,
    ...dispatchContextFlags(flags),
    screenshotCaptureBackend: flags?.maestro?.screenshotCaptureBackend,
    ...screenshotFlagsFromOptions(flags),
    clickButton: resolveClickButton(flags),
  };
}
