import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformResourceCleanup } from '../core/platform-resource-cleanup.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../core/request-runtime-binding.ts';
import type { SessionRef } from '../core/session-state.ts';
import type { SessionStore } from '../core/session-store.ts';
import { runtimeHintValues } from '../sessions/session-runtime.ts';
import { teardownSessionResources } from '../sessions/session-teardown.ts';
import { finalizeBoundSessionApplicationLifecycle } from './application-lifecycle-recovery.ts';

/** Ends the resources of a session whose lease expired, for a request that holds its locks. */
export async function teardownExpiredSession(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  platformCleanup: PlatformResourceCleanup | undefined;
}): Promise<void> {
  const { ref, sessionStore, inspectFacts, bindDevice } = params;
  const platformCleanup = requirePlatformCleanup(params.platformCleanup);
  const session = sessionStore.resolveCurrent(ref) ?? ref.session;
  const sessionName = ref.address;
  const runtimeHints = runtimeHintValues(sessionStore.getRuntimeHints(ref.address));
  let primaryError: unknown;
  try {
    await teardownSessionResources({
      appLog: 'run',
      ref,
      sessionStore,
      platformCleanup,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    await finalizeBoundSessionApplicationLifecycle({
      inspectFacts,
      bindDevice,
      session,
      stateDir: sessionStore.resolveDaemonStateDir(),
      runtimeHints,
    });
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      emitDiagnostic({
        level: 'error',
        phase: 'expired_session_lifecycle_cleanup_failed',
        data: {
          session: sessionName,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
        },
      });
    } else {
      throw cleanupError;
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

function requirePlatformCleanup(
  cleanup: PlatformResourceCleanup | undefined,
): PlatformResourceCleanup {
  if (!cleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  return cleanup;
}
