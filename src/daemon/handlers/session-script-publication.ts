import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { successText } from '../../utils/success-text.ts';
import {
  effectiveWriteForce,
  markActivePublicationDone,
  retargetActivePublication,
} from '../session-script-publication-capability.ts';
import { isRepairArmedSession } from '../session-replay-transaction.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';

export function handleSessionScriptPublication(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): DaemonResponse | null {
  const { req, sessionName, sessionStore } = params;
  if (req.command !== INTERNAL_COMMANDS.sessionSaveScript) return null;
  if ((req.positionals?.length ?? 0) > 1) {
    return failure(
      new AppError('INVALID_ARGS', 'session save-script accepts at most one output path.'),
    );
  }

  const session = sessionStore.get(sessionName);
  if (!session) {
    return failure(
      new AppError('SESSION_NOT_FOUND', `No active session "${sessionName}".`, {
        hint: 'Start a fresh journey with open <app> --save-script[=<path>], then retry.',
      }),
    );
  }
  const eligibilityError = validatePublicationEligibility(session);
  if (eligibilityError) return failure(eligibilityError);

  const explicitPath = req.positionals?.[0]?.trim();
  if (req.positionals?.[0] !== undefined && !explicitPath) {
    return failure(new AppError('INVALID_ARGS', 'session save-script path cannot be empty.'));
  }
  retargetActivePublication(session, { explicitPath, liveForce: req.flags?.force });

  const result = sessionStore.writeSessionLog(session, {
    force: effectiveWriteForce(session, req.flags?.force),
    publication: 'active',
  });
  if (!result.written) {
    return failure(
      result.error ??
        new AppError('COMMAND_FAILED', 'The active session script was not published.', {
          retriable: true,
          hint: 'The session remains armed; retry session save-script.',
        }),
    );
  }

  markActivePublicationDone(session, result.path);
  return {
    ok: true,
    data: {
      session: session.name,
      savedScript: result.path,
      actionCount: result.actionCount,
      ...successText(`Published script: ${result.path}`),
    },
  };
}

function validatePublicationEligibility(session: SessionState): AppError | undefined {
  if (isRepairArmedSession(session)) {
    return new AppError(
      'COMMAND_FAILED',
      'This session has an active .ad repair transaction and cannot use ordinary active-session publication.',
      {
        hint: 'Finish or abort the repair through replay --from and its existing close/teardown protocol.',
      },
    );
  }
  const state = session.scriptPublication;
  if (state?.kind === 'authoring' && state.status === 'aborted') {
    return new AppError(
      'COMMAND_FAILED',
      'This script recording was aborted by a second successful open and cannot be published.',
      { hint: 'Close this session and start a fresh one with open <app> --save-script[=<path>].' },
    );
  }
  if (state?.kind === 'authoring' && state.status === 'published') {
    return new AppError('COMMAND_FAILED', 'This script recording has already been published.', {
      hint: 'Continue using the live session, or close it and start a fresh authoring session.',
    });
  }
  if (state?.kind !== 'authoring' || state.status !== 'armed' || !session.recordSession) {
    return new AppError(
      'COMMAND_FAILED',
      'Script recording was not armed before this journey began; session history cannot be published without recording-time target evidence.',
      { hint: 'Close this session and start a fresh one with open <app> --save-script[=<path>].' },
    );
  }
  return undefined;
}

function failure(error: AppError): Extract<DaemonResponse, { ok: false }> {
  return { ok: false, error: normalizeError(error) };
}
