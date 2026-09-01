import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { NO_SCRIPT_PUBLICATION, scriptTargetPath } from '../../session-script-publication-state.ts';
import {
  effectiveWriteForce,
  isSessionScriptPublished,
  markCloseGeneratedPublicationDone,
} from '../../session-script-publication-capability.ts';
import { abortRepairTransaction, isRepairArmedSession } from '../../session-replay-transaction.ts';

export type RepairCloseCommit =
  | { kind: 'not-armed' }
  | { kind: 'committed'; path?: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: AppError };

function recordCloseAction(
  sessionStore: SessionStore,
  session: SessionState,
  req: DaemonRequest,
): void {
  sessionStore.recordAction(session, {
    command: 'close',
    positionals: req.positionals ?? [],
    flags: (req.flags ?? {}) as CommandFlags,
    result: { session: session.name, ...successText(`Closed: ${session.name}`) },
  });
}

export function commitRepairScriptBeforeClose(
  sessionStore: SessionStore,
  session: SessionState,
  req: DaemonRequest,
): RepairCloseCommit {
  if (!isRepairArmedSession(session)) return { kind: 'not-armed' };

  const actionsBeforeClose = session.actions.length;
  recordCloseAction(sessionStore, session, req);
  const alreadyPublished = isSessionScriptPublished(session);
  const result = sessionStore.writeSessionLog(session, {
    force: effectiveWriteForce(session, req.flags?.force),
  });
  if (result.written) return { kind: 'committed', path: result.path };
  if (result.error) {
    // The retained repair session can retry without accumulating synthetic closes.
    session.actions.length = actionsBeforeClose;
    return { kind: 'failed', error: result.error };
  }
  if (alreadyPublished) return { kind: 'committed' };
  abortRepairTransaction(session);
  return { kind: 'aborted' };
}

export function buildRetriableRepairCloseFailureResponse(
  session: SessionState,
  error: AppError,
): DaemonResponse {
  const normalized = normalizeError(error);
  const savedScript = scriptTargetPath(session.scriptPublication ?? NO_SCRIPT_PUBLICATION);
  return {
    ok: false,
    error: {
      ...normalized,
      details: {
        ...normalized.details,
        session: session.name,
        ...(savedScript ? { savedScript } : {}),
      },
      retriable: true,
    },
  };
}

export function finalizeOrdinaryCloseScript(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionStore: SessionStore;
  platformCloseError: unknown;
}): AppError | undefined {
  const { req, session, sessionStore, platformCloseError } = params;
  if (!platformCloseError) {
    recordCloseAction(sessionStore, session, req);
  }
  // The recorded close action already armed target/force through the recorder's flag ingress.
  // On a platform-close failure that action was never recorded, so the log still publishes to the
  // session default rather than the request's explicit path — the lifecycle armed by `open` is
  // what authorizes the write, and it is untouched by that failure.
  try {
    const result = sessionStore.writeSessionLog(session, {
      force: effectiveWriteForce(session, req.flags?.force),
    });
    if (result.written) markCloseGeneratedPublicationDone(session, result.path);
    return undefined;
  } catch (error) {
    return toOrdinaryCloseSaveScriptFailure(error);
  }
}

function toOrdinaryCloseSaveScriptFailure(error: unknown): AppError {
  const overrides = {
    hint: 'Remove the existing target (or pass --force/--overwrite), then re-record with open --save-script.',
    retriable: false,
  };
  if (error instanceof AppError) {
    return new AppError(
      'COMMAND_FAILED',
      `The session was closed, but its script was not saved: ${error.message}`,
      { ...error.details, ...overrides },
      error.cause,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `The session was closed, but its script was not saved: ${normalizeError(error).message}`,
    overrides,
  );
}
