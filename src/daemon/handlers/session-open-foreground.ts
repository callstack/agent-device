import { resolveSoleForegroundIosApp } from '../ios-app-session-hint.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { errorResponse } from './response.ts';

export type ForegroundOpenResolution =
  | { type: 'not-requested' }
  | { type: 'resolved'; req: DaemonRequest }
  | { type: 'response'; response: DaemonResponse };

/**
 * RFC prototype (branch claude/observe-foreground): `open --foreground` collapses the
 * `snapshot -i` (fails) -> read hint -> `open <bundleId>` -> `snapshot -i` dance into one
 * call for the common case (one booted iOS simulator, one running app).
 *
 * When `--foreground` is set with no explicit app argument on a fresh session, this
 * auto-resolves the target via `resolveSoleForegroundIosApp` — the exact same
 * ambiguity-detection probe that enriches the SESSION_NOT_FOUND hint — and rewrites the
 * request's positionals/flags so the rest of `handleOpenCommand`'s existing new-session
 * flow (device resolution, surface validation, session creation) runs completely
 * unmodified against the resolved device + bundle id. Only iOS simulators are handled;
 * see the PR body for scoped-out platforms.
 *
 * Fails closed with AMBIGUOUS_MATCH — never guesses — when the environment is not
 * unambiguous: zero or multiple booted simulators, zero or multiple running apps, or a
 * probe failure (the resolver owns the catch-all and reports failure as `undefined`,
 * never a rejection). This mirrors `buildIosOpenCommandHint`'s no-guessing contract
 * exactly, because it is built from the same underlying probe.
 */
export async function resolveForegroundOpenRequest(params: {
  req: DaemonRequest;
  hasExistingSession: boolean;
}): Promise<ForegroundOpenResolution> {
  const { req, hasExistingSession } = params;
  if (req.flags?.foreground !== true) return { type: 'not-requested' };

  if (hasExistingSession) {
    return {
      type: 'response',
      response: errorResponse(
        'INVALID_ARGS',
        'open --foreground only applies to a fresh session. Close the current session first, or omit --foreground.',
      ),
    };
  }
  if (req.positionals?.[0]) {
    return {
      type: 'response',
      response: errorResponse(
        'INVALID_ARGS',
        'open --foreground cannot be combined with an explicit app argument.',
      ),
    };
  }

  const resolved = await resolveSoleForegroundIosApp({
    simulatorSetPath: req.flags?.iosSimulatorDeviceSet,
  });
  if (!resolved) {
    return {
      type: 'response',
      response: errorResponse(
        'AMBIGUOUS_MATCH',
        'open --foreground requires an unambiguous environment: exactly one booted iOS simulator with exactly one app running.',
        {
          reason: 'foreground_app_ambiguous',
          hint: 'Pass an explicit app instead: agent-device open <app> --platform ios.',
        },
      ),
    };
  }

  return {
    type: 'resolved',
    req: {
      ...req,
      positionals: [resolved.app.bundleId],
      flags: { ...req.flags, udid: resolved.device.id, platform: 'ios' },
    },
  };
}

/**
 * The other half of the `open --foreground` composition: once `handleOpenCommand` has
 * created the session (with `session.appBundleId` now set), attach an initial
 * interactive snapshot by delegating to the EXISTING `snapshot` runtime dispatch
 * (`dispatchSnapshotViaRuntime`) — the same ref-issuing, session-store-updating path
 * `agent-device snapshot -i` uses. This is deliberately composition, not a new capture
 * pipeline: refs, snapshot lineage, and ref-frame activation all come from the one
 * capture path already trusted for `snapshot`.
 *
 * A no-op when `--foreground` was not requested, or when open itself failed (nothing to
 * attach a snapshot to).
 */
export async function composeOpenWithInitialSnapshot(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  openResponse: DaemonResponse;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, openResponse } = params;
  if (!openResponse.ok || req.flags?.foreground !== true) return openResponse;

  const snapshotResponse = await dispatchSnapshotViaRuntime({
    req: { ...req, command: 'snapshot', positionals: [] },
    sessionName,
    logPath,
    sessionStore,
  });
  if (!snapshotResponse.ok) return snapshotResponse;

  return {
    ok: true,
    data: { ...openResponse.data, snapshot: snapshotResponse.data },
  };
}
