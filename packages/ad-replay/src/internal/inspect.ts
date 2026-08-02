import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionAction } from '@agent-device/contracts/session';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  type ReplayScriptMetadata,
} from '@agent-device/ad-script';

/**
 * #1478 P5 stage C2b: the read-only `.ad` inspection façade. Moved out of
 * `session-replay-runtime.ts`'s old `parseReplayScript` (the fs read + the
 * legacy-JSON-payload rejection it guarded) plus the `parseReplayInput`
 * composition (`src/compat/replay-input.ts`) it fed into — this is the same
 * `parseReplayScriptDetailed` + `readReplayScriptMetadata` pair
 * `src/cli/commands/replay.ts` and `session-test-source-discovery.ts` already
 * call directly off `@agent-device/ad-script`; nothing beyond the actions,
 * line table, and header metadata those call sites read is exposed here.
 */
export type AdReplayManifest = Readonly<{
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  metadata: ReplayScriptMetadata;
}>;

/**
 * Reads `sourcePath` once and returns its parsed actions/line table plus
 * header metadata. Throws `AppError('INVALID_ARGS', …)` for the one source
 * format `.ad` replay no longer accepts — a legacy JSON replay payload —
 * matching the daemon's prior explicit rejection exactly. Callers do not need
 * to check for this case separately: `runReplayScriptFile`'s top-level catch
 * (`asAppError`) maps a thrown `AppError` straight to the same
 * `errorResponse` the old explicit branch built, so this is not a behavior
 * change, only where the check lives.
 */
export function inspectAdReplay(sourcePath: string): AdReplayManifest {
  const script = fs.readFileSync(sourcePath, 'utf8');
  const firstNonWhitespace = script.trimStart()[0];
  if (firstNonWhitespace === '{' || firstNonWhitespace === '[') {
    throw new AppError(
      'INVALID_ARGS',
      'replay accepts .ad script files. JSON replay payloads are no longer supported.',
    );
  }
  const parsed = parseReplayScriptDetailed(script);
  return {
    actions: parsed.actions,
    actionLines: parsed.actionLines,
    actionSourcePaths: parsed.actionSourcePaths,
    metadata: readReplayScriptMetadata(script),
  };
}
