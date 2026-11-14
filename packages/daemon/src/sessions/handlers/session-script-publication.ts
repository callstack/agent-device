import { withCaptureOutputOwnership } from '../../core/capture-output-ownership.ts';
import path from 'node:path';
import fs from 'node:fs';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import {
  effectiveWriteForce,
  isAuthoringArmedSession,
  markActivePublicationDone,
  retargetActivePublication,
} from '../../core/session-script-publication-capability.ts';
import { isRepairArmedSession } from '../../core/session-replay-transaction.ts';
import { SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionState } from '../../core/session-state.ts';

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

  const ref = sessionStore.lookup(sessionName);
  if (!ref) {
    return failure(
      new AppError('SESSION_NOT_FOUND', `No active session "${sessionName}".`, {
        hint: 'Start a fresh journey with open <app> --save-script[=<path>], then retry.',
      }),
    );
  }
  const session = sessionStore.requireCurrent(ref);
  const retained = retainedPublication(req, session);
  if (retained) return retained;
  const eligibilityError = validatePublicationEligibility(session);
  if (eligibilityError) return failure(eligibilityError);

  const explicitPath = req.positionals?.[0]?.trim();
  if (req.positionals?.[0] !== undefined && !explicitPath) {
    return failure(new AppError('INVALID_ARGS', 'session save-script path cannot be empty.'));
  }
  retargetActivePublication(
    session,
    {
      explicitPath,
      liveForce: req.flags?.force,
      clientPath: req.meta?.clientArtifactPaths?.savedScript,
      remote: req.internal?.remoteScriptDelivery,
    },
    sessionStore.host.cwd,
  );

  const result = sessionStore.writeSessionLog(ref, {
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

  markActivePublicationDone(session, result.path, result.actionCount);
  return publicationResponse(session, result.path, result.actionCount);
}

function retainedPublication(
  req: DaemonRequest,
  session: SessionState,
): DaemonResponse | undefined {
  const state = session.scriptPublication;
  if (
    state?.kind !== 'authoring' ||
    state.status !== 'published' ||
    state.target.kind !== 'explicit' ||
    state.target.remote !== true
  )
    return undefined;
  if (!fs.existsSync(state.target.path)) {
    return failure(
      new AppError(
        'COMMAND_FAILED',
        'The published script artifact has expired or is unavailable.',
        {
          reason: 'script_artifact_unavailable',
          hint: 'The recording is terminal. Start a fresh authoring session to record another journey.',
        },
      ),
    );
  }
  const requested = req.meta?.clientArtifactPaths?.savedScript;
  if ((req.positionals?.length ?? 0) > 0 && !requested) {
    return failure(
      new AppError(
        'INVALID_ARGS',
        'A published remote script accepts only a caller-side download destination.',
      ),
    );
  }
  const force =
    req.flags?.force === true ||
    ((!requested || requested === state.target.clientPath) && state.target.force);
  return publicationResponse(session, state.target.path, state.publishedActionCount ?? 0, {
    path: requested ?? state.target.clientPath ?? path.basename(state.target.path),
    force,
  });
}

function publicationResponse(
  session: SessionState,
  writtenPath: string,
  actionCount: number,
  download?: { path: string; force: boolean },
): DaemonResponse {
  const state = session.scriptPublication;
  const target = state?.kind === 'authoring' ? state.target : undefined;
  const localPath = download?.path ?? (target?.kind === 'explicit' ? target.clientPath : undefined);
  const artifacts =
    target?.kind === 'explicit' && target.remote === true
      ? [
          {
            field: 'savedScript',
            artifactType: 'session-script',
            path: writtenPath,
            localPath,
            fileName: path.basename(localPath ?? writtenPath),
            retainAfterDownload: true,
            force: download?.force ?? target.force,
          },
        ]
      : undefined;
  return {
    ok: true,
    data: withCaptureOutputOwnership(
      {
        session: session.name,
        savedScript: writtenPath,
        actionCount,
        ...(artifacts ? { artifacts } : {}),
        ...successText(`Published script: ${writtenPath}`),
      },
      target?.kind === 'explicit' && target.remote === true ? 'daemon' : 'caller',
    ),
  };
}

type PublicationIneligibility = 'repair' | 'aborted' | 'published' | 'not-armed';

/** Why this session cannot publish its active recording, or `undefined` when it can. */
function publicationIneligibility(session: SessionState): PublicationIneligibility | undefined {
  if (isRepairArmedSession(session)) return 'repair';
  const state = session.scriptPublication;
  if (state?.kind === 'authoring' && state.status !== 'armed') return state.status;
  return isAuthoringArmedSession(session) ? undefined : 'not-armed';
}

const PUBLICATION_INELIGIBILITY_ERRORS: Record<PublicationIneligibility, () => AppError> = {
  repair: () =>
    new AppError(
      'COMMAND_FAILED',
      'This session has an active .ad repair transaction and cannot use ordinary active-session publication.',
      {
        hint: 'Finish or abort the repair through replay --from and its existing close/teardown protocol.',
      },
    ),
  aborted: () =>
    new AppError(
      'COMMAND_FAILED',
      'This script recording was aborted by a second successful open and cannot be published.',
      { hint: 'Close this session and start a fresh one with open <app> --save-script[=<path>].' },
    ),
  published: () =>
    new AppError('COMMAND_FAILED', 'This script recording has already been published.', {
      hint: 'Continue using the live session, or close it and start a fresh authoring session.',
    }),
  'not-armed': () =>
    new AppError(
      'COMMAND_FAILED',
      'Script recording was not armed before this journey began; session history cannot be published without recording-time target evidence.',
      { hint: 'Close this session and start a fresh one with open <app> --save-script[=<path>].' },
    ),
};

function validatePublicationEligibility(session: SessionState): AppError | undefined {
  const reason = publicationIneligibility(session);
  return reason ? PUBLICATION_INELIGIBILITY_ERRORS[reason]() : undefined;
}

function failure(error: AppError): Extract<DaemonResponse, { ok: false }> {
  return { ok: false, error: normalizeError(error) };
}
