import type { CommandFlags } from '../../core/dispatch.ts';
import type { ReplayPlanDigestMetadata } from '../../replay/plan-digest.ts';
import type { ReplayScriptMetadata } from '../../replay/script.ts';
import type { DaemonResponse, SessionAction } from '../types.ts';
import { evaluateReplayResumePreflight } from './session-replay-resume.ts';
import { errorResponse } from './response.ts';

export function buildReplayMetadataFlags(
  flags: CommandFlags | undefined,
  metadata: ReplayScriptMetadata,
): CommandFlags {
  return {
    ...(flags ?? {}),
    ...(metadata.platform !== undefined && flags?.platform === undefined
      ? { platform: metadata.platform }
      : {}),
    ...(metadata.target !== undefined && flags?.target === undefined
      ? { target: metadata.target }
      : {}),
  };
}

/** The digest binds the same platform/target values the replay invokes with. */
export function readEffectiveReplayPlanDigestMetadata(
  flags: CommandFlags | undefined,
): ReplayPlanDigestMetadata {
  return {
    platform: typeof flags?.platform === 'string' ? flags.platform : undefined,
    target: typeof flags?.target === 'string' ? flags.target : undefined,
  };
}

type ReplayEntryIndexResult = { ok: true; value: number } | { ok: false; response: DaemonResponse };

/**
 * Resolves `--from`/`--plan-digest` into a 0-based loop entry index before
 * any device action. `--from` is 1-based and matches divergence step indices.
 */
export function resolveReplayEntryIndex(
  flags: CommandFlags | undefined,
  actionCount: number,
  planDigest: string,
  actions: SessionAction[],
): ReplayEntryIndexResult {
  const from = flags?.replayFrom;
  const digest = flags?.replayPlanDigest;
  if (from === undefined && digest === undefined) return { ok: true, value: 0 };
  if (from === undefined || digest === undefined) {
    return invalidReplayEntryIndex(
      'replay --from requires --plan-digest (and --plan-digest requires --from).',
    );
  }
  const message = validateReplayResumeRequest({ from, digest, planDigest, actionCount, actions });
  return message ? invalidReplayEntryIndex(message) : { ok: true, value: from - 1 };
}

function invalidReplayEntryIndex(message: string): ReplayEntryIndexResult {
  return { ok: false, response: errorResponse('INVALID_ARGS', message) };
}

function validateReplayResumeRequest(params: {
  from: number;
  digest: string;
  planDigest: string;
  actionCount: number;
  actions: SessionAction[];
}): string | undefined {
  const { from, digest, planDigest, actionCount, actions } = params;
  if (!Number.isInteger(from) || from < 1 || from > actionCount) {
    return `replay --from ${from} is out of range for a ${actionCount}-step plan.`;
  }
  if (digest !== planDigest) {
    return (
      'replay --plan-digest does not match the current plan digest; the script, its includes, or its ' +
      'platform-conditioned expansion changed since the divergence report was generated. Run a fresh full ' +
      'replay to get a new digest.'
    );
  }
  const preflight = evaluateReplayResumePreflight({ from, actions });
  return preflight.allowed ? undefined : `replay --from ${from} cannot resume: ${preflight.reason}`;
}
