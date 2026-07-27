import { AppError, normalizeError } from '../../kernel/errors.ts';
import { successText } from '../../utils/success-text.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { recordSessionAction } from './handler-utils.ts';

export type RepairCloseCommit =
  | { kind: 'not-armed' }
  | { kind: 'committed'; path?: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: AppError };

function shouldOverwriteSavedScript(req: DaemonRequest, session: SessionState): boolean {
  return Boolean(req.flags?.force || session.saveScriptForce);
}

export function commitRepairScriptBeforeClose(
  sessionStore: SessionStore,
  session: SessionState,
  req: DaemonRequest,
): RepairCloseCommit {
  if (session.saveScriptBoundary === undefined) return { kind: 'not-armed' };

  const actionsBeforeClose = session.actions.length;
  recordSessionAction(sessionStore, session, req, 'close', {
    session: session.name,
    ...successText(`Closed: ${session.name}`),
  });
  const result = sessionStore.writeSessionLog(session, {
    force: shouldOverwriteSavedScript(req, session),
  });
  if (result.written) return { kind: 'committed', path: result.path };
  if (result.error) {
    // The retained repair session can retry without accumulating synthetic closes.
    session.actions.length = actionsBeforeClose;
    return { kind: 'failed', error: result.error };
  }
  return session.saveScriptComplete ? { kind: 'committed' } : { kind: 'aborted' };
}

export function buildRetriableRepairCloseFailureResponse(
  session: SessionState,
  error: AppError,
): DaemonResponse {
  const normalized = normalizeError(error);
  return {
    ok: false,
    error: {
      ...normalized,
      details: {
        ...normalized.details,
        session: session.name,
        ...(session.saveScriptPath ? { savedScript: session.saveScriptPath } : {}),
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
    recordSessionAction(sessionStore, session, req, 'close', {
      session: session.name,
      ...successText(`Closed: ${session.name}`),
    });
  }
  if (req.flags?.saveScript) session.recordSession = true;

  try {
    sessionStore.writeSessionLog(session, {
      force: shouldOverwriteSavedScript(req, session),
    });
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
