import { AppError } from '@agent-device/kernel/errors';
import type { SessionAction } from '@agent-device/contracts/session';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  resolveDeclaredScriptPlatform,
  type ReplayScriptMetadata,
} from '@agent-device/ad-script';
import { computeReplayPlanDigest } from './plan-digest.ts';
import { resolveReplayEntryIndex, type PendingRecordAndHeal } from './resume.ts';

/**
 * #1478 P5 stage C2b: the read-only `.ad` inspection façade. Moved out of
 * `session-replay-runtime.ts`'s old `parseReplayScript` (the
 * legacy-JSON-payload rejection it guarded) plus the `parseReplayInput`
 * composition (`parseReplayInput`) it fed into — this is the same
 * `parseReplayScriptDetailed` + `readReplayScriptMetadata` pair
 * `src/cli/commands/replay.ts` and `session-test-source-discovery.ts` already
 * call directly off `@agent-device/ad-script`; nothing beyond the actions,
 * line table, and header metadata those call sites read is exposed here.
 *
 * #1555 review P1 ("digest/resume must also occur behind runAdReplay" —
 * satisfied via `inspectAdReplay`'s manifest for these two, since both are
 * needed BEFORE any device action and (for resume) before the daemon's own
 * session/coordinator preparation runs): `planDigest` and `resolveEntryIndex`
 * below are the plan-digest hash and the `--from`/`--plan-digest` resume-
 * point math, computed/exposed here instead of the daemon calling
 * `computeReplayPlanDigest`/`resolveReplayEntryIndex` directly. Neither is a
 * new top-level façade export — they are plain data/a closure hanging off
 * the manifest object `inspectAdReplay` already returns.
 */
export type AdReplayManifest = Readonly<{
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  metadata: ReplayScriptMetadata;
  /** SHA-256 digest of the canonical plan (`digestFlags` binds the same platform/target the replay invokes with). */
  planDigest: string;
  /** The `--from`/`--plan-digest` resume-point math, closed over this manifest's own `actions`/`planDigest`. */
  resolveEntryIndex(params: {
    from: number | undefined;
    digest: string | undefined;
    pendingRecordAndHeal: PendingRecordAndHeal | undefined;
    sessionActionsLength: number;
  }): { ok: true; value: number } | { ok: false; message: string };
}>;

/** The request-level `--platform`/`--target` override the plan digest binds (raw flags, before any metadata merge). */
export type AdReplayDigestFlags = Readonly<{ platform?: string; target?: string }>;

/**
 * Parses one `.ad` script's TEXT and returns its actions/line table, header
 * metadata, plan digest, and resume-index resolver. Takes the script itself,
 * never a path: #1802 made the CALLER read every script file a replay run
 * needs, so nothing below this façade opens a file. Throws
 * `AppError('INVALID_ARGS', …)` for the one source format `.ad` replay no
 * longer accepts — a legacy JSON replay payload — matching the daemon's
 * prior explicit rejection exactly. Callers do not need to check for this
 * case separately: `runReplayCommand`'s top-level catch (`asAppError`)
 * maps a thrown `AppError` straight to the same `errorResponse` the old
 * explicit branch built, so this is not a behavior change, only where the
 * check lives.
 *
 * `digestFlags` is the caller's raw request-level `--platform`/`--target`
 * (before any metadata merge) — the SAME precedence the daemon used to apply
 * itself: an explicit flag wins outright; absent that, a platform declared
 * by the script's own `runtime`/`open` actions before their first real
 * `open` wins; absent that, the `context platform=`/`target=` header line.
 */
export function inspectAdReplay(
  script: string,
  digestFlags?: AdReplayDigestFlags,
): AdReplayManifest {
  const firstNonWhitespace = script.trimStart()[0];
  if (firstNonWhitespace === '{' || firstNonWhitespace === '[') {
    throw new AppError(
      'INVALID_ARGS',
      'replay accepts .ad script files. JSON replay payloads are no longer supported.',
    );
  }
  const parsed = parseReplayScriptDetailed(script);
  const metadata = readReplayScriptMetadata(script);
  const planDigest = computeReplayPlanDigest({
    actions: parsed.actions,
    actionLines: parsed.actionLines,
    actionSourcePaths: parsed.actionSourcePaths,
    metadata: {
      platform:
        digestFlags?.platform ?? resolveDeclaredScriptPlatform(parsed.actions) ?? metadata.platform,
      target: digestFlags?.target ?? metadata.target,
    },
  });
  const actionCount = parsed.actions.length;
  return {
    actions: parsed.actions,
    actionLines: parsed.actionLines,
    actionSourcePaths: parsed.actionSourcePaths,
    metadata,
    planDigest,
    resolveEntryIndex: (params) => resolveReplayEntryIndex(params, actionCount, planDigest),
  };
}
