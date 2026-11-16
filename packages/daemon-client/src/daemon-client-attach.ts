import { AppError } from '@agent-device/kernel/errors';
import { ensureStartedDaemon } from './daemon-client-lifecycle.ts';
import { assertDaemonPolicyMatches, observeLocalDaemon } from './daemon-client-startup.ts';
import type {
  DaemonClientSettings,
  EnsuredDaemon,
  RemoteHealthRecovery,
} from './daemon-client-lifecycle.ts';
import { daemonBindingMismatchError } from './daemon-client-binding.ts';
import {
  DAEMON_UNAVAILABLE_REASONS,
  daemonIncompatibleError,
  daemonNotRunningError,
} from './daemon-lifecycle-errors.ts';

/** Resolves a remote or owned daemon, or verifies the daemon an attach client may use. */
export async function connectToDaemon(
  settings: DaemonClientSettings,
  healthRecovery?: RemoteHealthRecovery,
): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl || settings.ownedStateDir) {
    return await ensureStartedDaemon(settings, healthRecovery);
  }
  const stateDir = settings.paths.baseDir;
  const observed = await observeLocalDaemon(settings, { refineUnreachable: true }).catch(
    (error: unknown) => {
      if (
        settings.daemonBinding &&
        error instanceof AppError &&
        error.details?.reason === DAEMON_UNAVAILABLE_REASONS.recordUnreadable.reason
      ) {
        throw daemonBindingMismatchError(settings.daemonBinding, null, stateDir);
      }
      throw error;
    },
  );
  if (!observed) {
    if (settings.daemonBinding) {
      throw daemonBindingMismatchError(settings.daemonBinding, null, stateDir);
    }
    throw daemonNotRunningError(stateDir);
  }
  const { info, decision } = observed;
  switch (decision.kind) {
    case 'reuse':
      break;
    case 'refuseNewer':
      throw await daemonIncompatibleError({ info, mismatch: 'newer', stateDir });
    case 'replace':
      throw decision.cause === 'unreachable'
        ? daemonNotRunningError(stateDir, info)
        : await daemonIncompatibleError({ info, mismatch: decision.cause, stateDir });
  }
  const binding = settings.daemonBinding;
  if (
    binding &&
    (info.token !== binding.token ||
      info.pid !== binding.pid ||
      info.processStartTime !== binding.processStartTime)
  ) {
    throw daemonBindingMismatchError(binding, info, stateDir);
  }
  await assertDaemonPolicyMatches(info, stateDir, settings.host);
  return { info, startedByClient: false };
}
