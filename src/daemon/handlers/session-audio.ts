import { isCommandSupportedOnDevice } from '../../core/capabilities.ts';
import { normalizeError } from '../../kernel/errors.ts';
import {
  resolveHostAudioProbeBackend,
  type HostAudioProbeBackend,
} from '../../platforms/audio-probe-backend.ts';
import { resolveWebProvider } from '../../platforms/web/provider.ts';
import { runHostSystemAudioProbeCommand } from '../audio-probe.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';

const AUDIO_ACTIONS = ['probe'] as const;
const AUDIO_PROBE_ACTIONS = ['start', 'status', 'stop'] as const;
const AUDIO_ACTIONS_MESSAGE = 'audio requires probe';
const AUDIO_PROBE_ACTIONS_MESSAGE = `audio probe requires ${AUDIO_PROBE_ACTIONS.join(', ')}`;

type AudioParams = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
};

export async function handleAudioCommand(params: AudioParams): Promise<DaemonResponse> {
  const request = resolveAudioCommandRequest(params);
  if (!request.ok) return request;
  const hostBackend = await resolveHostAudioProbeBackend(request.session.device);
  if (hostBackend) {
    return await handleHostSystemAudioCommand(params, request, hostBackend);
  }
  const provider = resolveWebProvider();
  if (!provider.probeAudio) {
    return errorResponse('UNSUPPORTED_OPERATION', 'audio is not supported by this web provider');
  }

  try {
    return {
      ok: true,
      data: await provider.probeAudio({
        action: request.probeAction,
        durationMs: request.durationMs,
        bucketMs: request.bucketMs,
      }),
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function resolveAudioCommandRequest(params: AudioParams):
  | {
      ok: true;
      session: SessionState;
      probeAction: 'start' | 'status' | 'stop';
      durationMs: number;
      bucketMs: number;
    }
  | DaemonFailureResponse {
  const sessionResult = resolveAudioSession(params);
  if (!sessionResult.ok) return sessionResult;
  const actionResult = resolveAudioProbeAction(params.req);
  if (!actionResult.ok) return actionResult;
  const timingResult = resolveAudioProbeTiming(params.req, actionResult.probeAction);
  if (!timingResult.ok) return timingResult;
  return {
    ok: true,
    session: sessionResult.session,
    probeAction: actionResult.probeAction,
    ...timingResult.timing,
  };
}

function resolveAudioSession(
  params: AudioParams,
): { ok: true; session: SessionState } | DaemonFailureResponse {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return errorResponse('SESSION_NOT_FOUND', 'audio requires an active session');
  return isCommandSupportedOnDevice('audio', session.device)
    ? { ok: true, session }
    : errorResponse(
        'UNSUPPORTED_OPERATION',
        'audio is supported for web browser sessions, macOS sessions, iOS simulators, and Android emulators on macOS hosts',
      );
}

type ResolvedAudioCommandRequest = Extract<
  ReturnType<typeof resolveAudioCommandRequest>,
  { ok: true }
>;

async function handleHostSystemAudioCommand(
  params: AudioParams,
  request: ResolvedAudioCommandRequest,
  backend: HostAudioProbeBackend,
): Promise<DaemonResponse> {
  try {
    return {
      ok: true,
      data: await runHostSystemAudioProbeCommand({
        session: request.session,
        sessionName: params.sessionName,
        sessionStore: params.sessionStore,
        backend,
        probeAction: request.probeAction,
        durationMs: request.durationMs,
        bucketMs: request.bucketMs,
      }),
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function resolveAudioProbeAction(
  req: DaemonRequest,
): { ok: true; probeAction: 'start' | 'status' | 'stop' } | DaemonFailureResponse {
  const audioAction = readAudioAction(req.positionals?.[0]);
  if (!audioAction) return errorResponse('INVALID_ARGS', AUDIO_ACTIONS_MESSAGE);
  const probeAction = readAudioProbeAction(req.positionals?.[1]);
  if (!probeAction) return errorResponse('INVALID_ARGS', AUDIO_PROBE_ACTIONS_MESSAGE);
  return { ok: true, probeAction };
}

function resolveAudioProbeTiming(
  req: DaemonRequest,
  probeAction: 'start' | 'status' | 'stop',
): { ok: true; timing: { durationMs: number; bucketMs: number } } | DaemonFailureResponse {
  if (probeAction !== 'start' && req.positionals && req.positionals.length > 2) {
    return errorResponse(
      'INVALID_ARGS',
      'audio probe duration and bucket are only supported with audio probe start',
    );
  }
  const durationMs = readBoundedInteger(req.positionals?.[2], {
    defaultValue: 10_000,
    min: 100,
    max: 120_000,
    message: 'audio probe duration must be an integer in range 100..120000 ms',
  });
  if (durationMs instanceof Error) return errorResponse('INVALID_ARGS', durationMs.message);

  const bucketMs = readBoundedInteger(req.positionals?.[3], {
    defaultValue: 1_000,
    min: 100,
    max: 10_000,
    message: 'audio probe bucket must be an integer in range 100..10000 ms',
  });
  if (bucketMs instanceof Error) return errorResponse('INVALID_ARGS', bucketMs.message);
  return { ok: true, timing: { durationMs, bucketMs } };
}

function readAudioAction(value: string | undefined): 'probe' | undefined {
  const action = (value ?? 'probe').toLowerCase();
  return AUDIO_ACTIONS.includes(action as (typeof AUDIO_ACTIONS)[number]) ? 'probe' : undefined;
}

function readAudioProbeAction(value: string | undefined): 'start' | 'status' | 'stop' | undefined {
  const probeAction = (value ?? 'status').toLowerCase();
  return AUDIO_PROBE_ACTIONS.includes(probeAction as (typeof AUDIO_PROBE_ACTIONS)[number])
    ? (probeAction as 'start' | 'status' | 'stop')
    : undefined;
}

function readBoundedInteger(
  value: string | undefined,
  params: { defaultValue: number; min: number; max: number; message: string },
): number | Error {
  if (value === undefined) return params.defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== value ||
    parsed < params.min ||
    parsed > params.max
  ) {
    return new Error(params.message);
  }
  return parsed;
}
