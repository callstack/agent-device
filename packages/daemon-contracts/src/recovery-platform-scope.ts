import type {
  PlatformDiagnosticEvent,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

const processLifetimeSignal = new AbortController().signal;

/** Process-owned scope for post-lock durable-resource recovery before request admission. */
export function createRecoveryPlatformScope(): PlatformRequestScope {
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
