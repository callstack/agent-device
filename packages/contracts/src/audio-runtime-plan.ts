import { AppError } from '@agent-device/kernel/errors';
import { defineUse } from './platform-runtime-operations.ts';
import type { AudioProbeQueryAction } from './audio-probe-runtime.ts';

/**
 * `audio`'s action-selected uses (ADR 0019 §9: one bind per handler). The durable host capture
 * and the stateless page probe are separate cells because no owner has both: the darwin host
 * families own the ScreenCaptureKit capture, the web family owns the in-page probe. Recovery is
 * its own use so daemon-restart reattachment binds exactly the exact-owner pair it needs.
 */
export const audioProbeStartUse = defineUse({ required: ['audioProbeStart'] });
export const audioProbeRecoveryUse = defineUse({
  required: ['audioProbeReattach', 'audioProbeCleanup'],
});
const audioProbeQueryUse = defineUse({ required: ['audioProbeQuery'] });

export const audioRuntimePlanUses = Object.freeze([
  audioProbeStartUse,
  audioProbeRecoveryUse,
  audioProbeQueryUse,
] as const);

/**
 * `capture-status` and `capture-stop` carry no use: they operate the session's adopted live
 * handle (or its recovery record), never a fresh device binding — the same shape as `record`'s
 * stop-live plan.
 */
export type AudioRuntimePlan =
  | Readonly<{ kind: 'capture-start'; use: typeof audioProbeStartUse }>
  | Readonly<{ kind: 'capture-status' }>
  | Readonly<{ kind: 'capture-stop' }>
  | Readonly<{ kind: 'query'; action: AudioProbeQueryAction; use: typeof audioProbeQueryUse }>;

/**
 * The mode is a device fact, not an argument: the handler reads it from side-effect-free facts
 * inspection (`audioProbeStart` available → capture, else `audioProbeQuery` available → query)
 * and hands it in, keeping resolution pure.
 */
export function resolveAudioRuntimePlan(
  input: Readonly<{ probeAction: AudioProbeQueryAction; mode: 'capture' | 'query' }>,
): AudioRuntimePlan {
  if (input.mode === 'query') {
    return Object.freeze({ kind: 'query', action: input.probeAction, use: audioProbeQueryUse });
  }
  switch (input.probeAction) {
    case 'start':
      return Object.freeze({ kind: 'capture-start', use: audioProbeStartUse });
    case 'status':
      return Object.freeze({ kind: 'capture-status' });
    case 'stop':
      return Object.freeze({ kind: 'capture-stop' });
  }
}

const AUDIO_ACTIONS = ['probe'] as const;
const AUDIO_PROBE_ACTIONS = ['start', 'status', 'stop'] as const;

export type AudioProbeRequest = Readonly<{
  probeAction: AudioProbeQueryAction;
  durationMs: number;
  bucketMs: number;
}>;

/**
 * The one positional grammar for `audio probe [start|status|stop] [durationMs] [bucketMs]`,
 * shared by the daemon route so its parsing cannot drift from the command surface. Errors are
 * `INVALID_ARGS` with the exact legacy wording.
 */
export function parseAudioProbeRequest(
  positionals: readonly string[] | undefined,
): AudioProbeRequest {
  const action = (positionals?.[0] ?? 'probe').toLowerCase();
  if (!AUDIO_ACTIONS.includes(action as (typeof AUDIO_ACTIONS)[number])) {
    throw new AppError('INVALID_ARGS', 'audio requires probe');
  }
  const probeAction = (positionals?.[1] ?? 'status').toLowerCase();
  if (!AUDIO_PROBE_ACTIONS.includes(probeAction as (typeof AUDIO_PROBE_ACTIONS)[number])) {
    throw new AppError('INVALID_ARGS', `audio probe requires ${AUDIO_PROBE_ACTIONS.join(', ')}`);
  }
  if (probeAction !== 'start' && positionals && positionals.length > 2) {
    throw new AppError(
      'INVALID_ARGS',
      'audio probe duration and bucket are only supported with audio probe start',
    );
  }
  return Object.freeze({
    probeAction: probeAction as AudioProbeQueryAction,
    durationMs: readBoundedInteger(positionals?.[2], {
      defaultValue: 10_000,
      min: 100,
      max: 120_000,
      message: 'audio probe duration must be an integer in range 100..120000 ms',
    }),
    bucketMs: readBoundedInteger(positionals?.[3], {
      defaultValue: 1_000,
      min: 100,
      max: 10_000,
      message: 'audio probe bucket must be an integer in range 100..10000 ms',
    }),
  });
}

function readBoundedInteger(
  value: string | undefined,
  params: Readonly<{ defaultValue: number; min: number; max: number; message: string }>,
): number {
  if (value === undefined) return params.defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== value ||
    parsed < params.min ||
    parsed > params.max
  ) {
    throw new AppError('INVALID_ARGS', params.message);
  }
  return parsed;
}
