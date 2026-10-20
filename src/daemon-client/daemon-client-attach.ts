import { ensureManagedDaemon } from './daemon-client-lifecycle.ts';
import { assertDaemonPolicyMatches, observeLocalDaemon } from './daemon-client-startup.ts';
import type { DaemonClientSettings, EnsuredDaemon } from './daemon-client-lifecycle.ts';
import type { DaemonBinding } from '@agent-device/contracts/client';
import { readDaemonRecord } from '@agent-device/daemon-contracts/daemon-resolution';
import { daemonBindingMismatchError, readPinnedDaemonRecord } from './daemon-client-binding.ts';
import { daemonIncompatibleError, daemonNotRunningError } from './daemon-lifecycle-errors.ts';

/**
 * Connects to the one daemon instance this client is pinned to, and to no other. It compares the
 * state directory's record before dispatch and never starts, replaces, retires, or redirects: a pin
 * is the host's answer to "which daemon", so any other instance is a refusal, not a candidate.
 */
async function attachBoundDaemon(
  binding: DaemonBinding,
  settings: DaemonClientSettings,
): Promise<EnsuredDaemon> {
  const pinned = readPinnedDaemonRecord(binding, readDaemonRecord(settings.paths.infoPath));
  if ('mismatch' in pinned) {
    throw daemonBindingMismatchError(binding, pinned, settings.paths.baseDir);
  }
  // The record matched the pin, so it is the pinned instance. The request goes out with the pin's own
  // token anyway: a replacement that lands after this read then fails authentication at the daemon
  // rather than being served by a token this client never agreed to use.
  return { info: { ...pinned.registered, token: binding.token }, startedByClient: false };
}

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

/** The daemon a request goes to, by the lifecycle and pin its client chose. A remote one is never ours. */
export async function connectToDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl) {
    return await ensureManagedDaemon(settings);
  }
  const binding = settings.daemonBinding;
  const attached = binding
    ? await attachBoundDaemon(binding, settings)
    : settings.daemonLifecycle === 'attach'
      ? await attachLocalDaemon(settings)
      : await ensureManagedDaemon(settings);
  // A pin never reaches the remote branch: a client that pins an instance and names a base URL is
  // refused where its settings are read. Checked on this branch too: attaching must not hand a
  // policy-bound caller a daemon without it.
  await assertDaemonPolicyMatches(attached.info, settings.paths.baseDir, settings.host);
  return attached;
}
