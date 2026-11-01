import { normalizeError } from '@agent-device/kernel/errors';
import {
  emitDiagnostic,
  type DiagnosticLevel,
  type ResourceDiagnostic,
} from '@agent-device/host-kit/diagnostics';
import type { OwnerIdentity } from '@agent-device/host-kit/process';
import type { DaemonRegistrationOwner } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { withDaemonDiagnosticsScope } from '@agent-device/daemon-contracts/daemon-diagnostics-scope';
import { watchDaemonMetadataLoss } from './daemon-metadata-loss.ts';

export async function flushDaemonStartupDiagnostics(
  logPath: string,
  diagnostics: readonly ResourceDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  await withDaemonDiagnosticsScope({ logPath, command: 'daemon-startup', debug: false }, () => {
    for (const diagnostic of diagnostics) {
      emitDiagnostic({
        level: 'warn',
        phase: diagnostic.phase,
        data: { resourcePath: diagnostic.resourcePath, ...diagnostic.data },
      });
    }
  });
}

/**
 * Records one daemon-level event outside any request scope, with debug forced on.
 * `level` is the event's own severity; it defaults to `warn` because these events are all daemon
 * shutdown or recovery problems, and a caller passes another only to keep a severity its own owner
 * already decided.
 */
export async function emitDaemonDiagnostic(
  logPath: string,
  phase: string,
  data: Record<string, unknown>,
  level: DiagnosticLevel = 'warn',
): Promise<void> {
  await withDaemonDiagnosticsScope({ logPath }, () => {
    emitDiagnostic({ level, phase, data });
  });
}

export async function finishDaemonRegistration(params: {
  registration: DaemonRegistrationOwner;
  infoPath: string;
  logPath: string;
  outcome?: Parameters<DaemonRegistrationOwner['finish']>[0];
  close?: Parameters<DaemonRegistrationOwner['finish']>[1];
}): Promise<void> {
  try {
    const removal = await params.registration.finish(params.outcome, params.close);
    if (removal.state !== 'removed' && removal.state !== 'absent') {
      await emitDaemonDiagnostic(params.logPath, 'daemon_info_removal_declined', {
        infoPath: params.infoPath,
        removed: false,
        reason: removal.state,
        ...(removal.state === 'replaced' ? { registeredPid: removal.identity.pid } : {}),
      });
    }
  } catch (error) {
    await emitDaemonDiagnostic(params.logPath, 'daemon_registration_finish_failed', {
      error: normalizeError(error),
    });
  }
}

/** Watches this registration being taken over; arm only after this process published. */
export function armDaemonMetadataLossWatch(
  stateDir: string,
  infoPath: string,
  logPath: string,
  owner: OwnerIdentity,
): () => void {
  return watchDaemonMetadataLoss({
    infoPath,
    stateDir,
    owner,
    onLoss: (loss) =>
      void emitDaemonDiagnostic(logPath, 'daemon_metadata_lost', {
        infoPath,
        ...loss,
      }).catch(() => {}),
  });
}
