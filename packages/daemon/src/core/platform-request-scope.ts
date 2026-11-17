import type {
  PlatformDiagnosticEvent,
  PlatformProgressUpdate,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import {
  getRequestSignal,
  emitRequestProgress,
  throwIfRequestExecutionDeadlineExceeded,
} from '@agent-device/host-kit/request';

import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonRequest } from './daemon-request.ts';

const processLifetimeSignal = new AbortController().signal;

export function createPlatformRequestScope(req: DaemonRequest): PlatformRequestScope {
  const requestId = req.meta?.requestId;
  return Object.freeze({
    signal: getRequestSignal(requestId) ?? processLifetimeSignal,
    checkDeadline: () => throwIfRequestExecutionDeadlineExceeded(requestId),
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
