import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
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
 * `open --foreground` collapses the
 * `snapshot -i` (fails) -> read hint -> `open <bundleId>` -> `snapshot -i` dance into one
 * call for the common case (one booted iOS simulator, one running app).
 *
 * When `--foreground` is set with an explicit app, normal open resolution remains the
 * source of truth for app and device selection; this module only composes the initial
 * snapshot after open succeeds. That makes the deterministic, configured-target form
 * (`open <app> --foreground`) the cheap path for harnesses and other callers that already
 * know the foreground bundle.
 *
 * Without an app argument, this auto-resolves the target via
 * `resolveSoleForegroundIosApp` — the exact same ambiguity-detection probe that enriches
 * the SESSION_NOT_FOUND hint — and rewrites the request's positionals/flags so the rest
 * of `handleOpenCommand`'s existing new-session flow runs unmodified against the resolved
 * device + bundle id. Only iOS simulators are handled; see the PR body for scoped-out
 * platforms.
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

  // With an explicit app, foreground means "open through the normal target
  // path, then compose the initial snapshot". That remains valid for an
  // existing session: normal open owns switching/relaunching the app and the
  // composition below observes the resulting session state.
  if (req.positionals?.[0]) return { type: 'resolved', req };

  if (hasExistingSession) {
    return {
      type: 'response',
      response: errorResponse(
        'INVALID_ARGS',
        'open --foreground only applies to a fresh session. Close the current session first, or omit --foreground.',
      ),
    };
  }
  // #1670 P1: the resolved-device rewrite below pins --udid/--platform, so an
  // explicit selector must fail fast instead of being silently overwritten
  // (open --foreground --udid B with sim A sole-booted must NOT open A).
  if (req.flags?.udid !== undefined || req.flags?.device !== undefined) {
    return {
      type: 'response',
      response: errorResponse(
        'INVALID_ARGS',
        'open --foreground resolves the device itself; drop --udid/--device or open explicitly: agent-device open <app> --udid <udid>.',
      ),
    };
  }
  if (req.flags?.platform !== undefined && req.flags.platform !== 'ios') {
    return {
      type: 'response',
      response: errorResponse(
        'INVALID_ARGS',
        'open --foreground only supports --platform ios; drop the flag or pass --platform ios.',
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
 *
 * #1670 P1: a capture failure must never mask the successful open — the session exists
 * either way, and returning the capture error made a retry of `open --foreground` fail
 * with "close the current session first". Open success + snapshot failure returns
 * `ok: true` with an explicit `initialSnapshotError` detail and a rendered warning
 * telling the caller the session IS open and how to capture manually.
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

  try {
    const snapshotResponse = await dispatchSnapshotViaRuntime({
      req: {
        ...req,
        command: 'snapshot',
        positionals: [],
        // The promised composition IS `snapshot -i`: the CLI maps `-i` to
        // `snapshotInteractiveOnly` (flag-definitions-workflow.ts), which is the
        // key the snapshot runtime reads as `interactiveOnly`.
        flags: { ...req.flags, snapshotInteractiveOnly: true },
      },
      sessionName,
      logPath,
      sessionStore,
    });
    if (!snapshotResponse.ok) {
      return openWithInitialSnapshotFailure(openResponse.data, snapshotResponse.error);
    }
    return {
      ok: true,
      data: { ...openResponse.data, snapshot: snapshotResponse.data },
    };
  } catch (error) {
    // The dispatch can also THROW (capture/runner exceptions are rethrown after
    // the runtime's own handling). An escaped rejection would fail the whole
    // open after the session was created — the exact masking this composition
    // exists to prevent — so a thrown capture failure gets the same
    // successful-open contract as a returned one.
    return openWithInitialSnapshotFailure(openResponse.data, normalizeError(error));
  }
}

function openWithInitialSnapshotFailure(
  openData: Record<string, unknown> | undefined,
  error: NormalizedError,
): DaemonResponse {
  return {
    ok: true,
    data: {
      ...openData,
      warnings: [
        ...readStringWarnings(openData),
        `The session is open, but the initial interactive snapshot failed (${error.code}: ${error.message}). Run: agent-device snapshot -i`,
      ],
      // The FULL error shape (hint/details/diagnosticId/logPath), not a
      // code+message truncation — recovery guidance must survive to the
      // public Node/CLI JSON surfaces.
      initialSnapshotError: error,
    },
  };
}

function readStringWarnings(data: Record<string, unknown> | undefined): string[] {
  if (!data || !Array.isArray(data.warnings)) return [];
  return data.warnings.filter((warning): warning is string => typeof warning === 'string');
}
