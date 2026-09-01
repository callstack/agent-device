import { REF_GRAMMAR_HINT, splitRefGenerationSuffix } from '@agent-device/kernel/snapshot';
import type { DaemonResponse } from './types.ts';
import { errorResponse } from './response.ts';

/**
 * Daemon boundary for the versioned-ref suffix (#1076): a pinned `@e12~s3`
 * target is split here so everything downstream (runtime resolution, backend
 * fast paths, recording) sees exactly today's plain `@e12` ref, while the
 * minted generation is surfaced separately for the staleness warning.
 */
export type ParsedVersionedRef =
  | { ok: true; ref: string; generation?: number }
  | { ok: false; response: DaemonResponse };

export function parseVersionedRefPositional(refInput: string): ParsedVersionedRef {
  const split = splitRefGenerationSuffix(refInput);
  if (!split) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Invalid ref "${refInput}" — malformed generation suffix.`,
        { hint: REF_GRAMMAR_HINT },
      ),
    };
  }
  return { ok: true, ref: split.base, generation: split.generation };
}
