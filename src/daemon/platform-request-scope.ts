import type {
  PlatformDiagnosticEvent,
  PlatformProgressUpdate,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { getRequestSignal } from '../request/cancel.ts';
import { emitRequestProgress } from '../request/progress.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { DaemonRequest } from './types.ts';

const processLifetimeSignal = new AbortController().signal;

export function createPlatformRequestScope(req: DaemonRequest): PlatformRequestScope {
  return Object.freeze({
    signal: getRequestSignal(req.meta?.requestId) ?? processLifetimeSignal,
    diagnostics: Object.freeze({
      emit: (event: PlatformDiagnosticEvent) => emitDiagnostic(event),
    }),
    progress: Object.freeze({
      report: (update: PlatformProgressUpdate) =>
        emitRequestProgress({
          type: 'command',
          status: 'progress',
          message: update.message,
        }),
    }),
  });
}

/** Process-owned scope for post-lock durable-resource recovery before request admission. */
export function createDaemonRecoveryPlatformScope(): PlatformRequestScope {
  return Object.freeze({
    signal: processLifetimeSignal,
    diagnostics: Object.freeze({
      emit: (event: PlatformDiagnosticEvent) => emitDiagnostic(event),
    }),
    progress: Object.freeze({
      report: () => {},
    }),
  });
}
