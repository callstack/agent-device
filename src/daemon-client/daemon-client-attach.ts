import { ensureManagedDaemon } from './daemon-client-lifecycle.ts';
import { assertDaemonPolicyMatches, observeLocalDaemon } from './daemon-client-startup.ts';
import type { DaemonClientSettings, EnsuredDaemon } from './daemon-client-lifecycle.ts';
import { daemonIncompatibleError, daemonNotRunningError } from './daemon-lifecycle-errors.ts';

/**
 * Connects to the local daemon registered in the state directory and nothing else: it never starts,
 * replaces or kills one. What the registration says is judged by the same ladder a managed client
 * uses, so a daemon an attach client accepts is one a managed client would also reuse.
 */
async function attachLocalDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const stateDir = settings.paths.baseDir;
  const observed = await observeLocalDaemon(settings, { refineUnreachable: true });
  if (!observed) throw daemonNotRunningError(stateDir);
  const { info, decision } = observed;
  switch (decision.kind) {
    case 'reuse':
      return { info, startedByClient: false };
    case 'refuseNewer':
      throw await daemonIncompatibleError({ info, mismatch: 'newer', stateDir });
    case 'replace':
      throw decision.cause === 'unreachable'
        ? daemonNotRunningError(stateDir, info)
        : await daemonIncompatibleError({ info, mismatch: decision.cause, stateDir });
  }
}

/** The daemon a request goes to, by the lifecycle its client chose. A remote one is never ours. */
export async function connectToDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl || settings.daemonLifecycle !== 'attach') {
    return await ensureManagedDaemon(settings);
  }
  const attached = await attachLocalDaemon(settings);
  // Checked on this branch too: attaching must not hand a policy-bound caller a daemon without it.
  await assertDaemonPolicyMatches(attached.info, settings.paths.baseDir, settings.host);
  return attached;
}
