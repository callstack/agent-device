import path from 'node:path';
import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  DaemonRequestMeta,
  DaemonResponse,
  ScriptDeliveryFailure,
} from '@agent-device/kernel/contracts';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import type { AppError } from '@agent-device/kernel/errors';
import type { SessionStore } from './session-store.ts';
import { asDaemonDeliveredArtifact } from './capture-output-ownership.ts';
import type { SessionState } from './session-state.ts';
import {
  NO_SCRIPT_PUBLICATION,
  abortAuthoring,
  armAuthoring,
  armRepair,
  isAuthoringAborted,
  isRecordingPublication,
  isScriptPublished,
  markAuthoringPublished,
  resolveScriptTarget,
  scriptTargetForce,
  scriptTargetPath,
  type RemoteScriptDelivery,
} from './session-script-publication-state.ts';
import { expandSessionPath } from '@agent-device/host-kit/session-paths';

/**
 * `SessionScriptPublication` (#1478 P4a): the daemon-private projection owning every supported
 * ordinary-authoring write — arming on `open`, the shared `--save-script` flag ingress on
 * recorded actions, active publication (`session save-script`), and the published transition.
 * Repair transitions live in `session-replay-transaction.ts`; the two variants stay disjoint by
 * construction of the aggregate. Engines can reach neither.
 */

function publicationState(session: SessionState | undefined) {
  return session?.scriptPublication ?? NO_SCRIPT_PUBLICATION;
}

/**
 * An ordinary authoring session still open to recording: the ADR 0016 lifecycle before it aborts
 * or publishes. The authoring counterpart of `isRepairArmedSession`, and the one shape the
 * handlers ask about — a second `open` aborts it, `close --save-script` may still publish it, and
 * active publication is eligible only from it.
 */
export function isAuthoringArmedSession(session: SessionState | undefined): boolean {
  const state = publicationState(session);
  return state.kind === 'authoring' && state.status === 'armed';
}

/**
 * ADR 0016: `open <app> --save-script[=<path>]` on a fresh session arms ordinary authoring. A
 * remote recording is delivered under the publication ID its caller minted.
 */
export function armAuthoringOnOpen(
  session: SessionState,
  requested: { path?: string; force?: boolean },
  hostCwd: string,
  remote?: Omit<RemoteScriptDelivery, 'revision'>,
): void {
  session.scriptPublication = armAuthoring(
    {
      path: requested.path !== undefined ? expandSessionPath(requested.path, hostCwd) : undefined,
      force: requested.force === true,
    },
    remote ? { ...remote, revision: 0 } : undefined,
  );
}

/**
 * The remote delivery an `open --save-script` asks for: the publication ID its client minted, when
 * well formed, and the tenant that opens it.
 */
export function remoteScriptOpen(
  meta: DaemonRequestMeta | undefined,
): Omit<RemoteScriptDelivery, 'revision'> | undefined {
  const publicationId = meta?.scriptPublicationId;
  if (typeof publicationId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(publicationId)) {
    return undefined;
  }
  return { publicationId, tenantId: meta?.tenantId };
}

/**
 * ADR 0016: a second successful `open` on an armed authoring session terminates the recording —
 * the journey no longer starts where the script says it does.
 */
export function abortAuthoringOnSecondOpen(session: SessionState): void {
  session.scriptPublication = abortAuthoring(publicationState(session));
}

/**
 * Whether the session captures recording-time evidence (`isRecordingPublication`).
 *
 * The one question every recording-sensitive site asks, answered from the aggregate rather than
 * from a boolean kept in step with it by hand. No surface can arm recording without moving the
 * lifecycle that authorizes it, which is what makes #1533's drift unrepresentable rather than
 * merely guarded against.
 */
export function isSessionRecording(session: SessionState | undefined): boolean {
  return isRecordingPublication(publicationState(session));
}

/**
 * The shared `--save-script` ingress on a RECORDED action (`open`/`close`; #1501 pins every
 * other command's raw flag closed at the router). Arms recording and applies target/force to
 * whichever lifecycle the session is in:
 *
 * - `none` -> ordinary authoring armed. This branch is UNREACHABLE for `close`: live evidence
 *   (2026-08-02) showed it used to let a never-armed `close --save-script` fold into the
 *   authoring lifecycle and publish moments later in the same request — a script with selector
 *   fallback chains but no recording-time `target-v1` evidence, and no signal to the caller.
 *   `session-lifecycle/internal/session-close.ts`'s `assertTerminalRecordingCloseAllowed` now
 *   rejects an unarmed `close --save-script` before any action recording runs, so this arm only
 *   fires for a future non-close caller of the shared ingress; it is kept as that caller's safety
 *   net, not as a documented close-time behavior.
 * - `authoring` -> retarget under the #1258 per-target force rule (`resolveScriptTarget`).
 * - `repair` -> retarget the repair target the same way (a replayed step may carry the flag).
 *
 * - `authoring{aborted}` -> nothing. The lifecycle is terminal (#1533), so the flag neither
 *   re-arms recording nor retargets: recording-time evidence stopped at the abort.
 */
export function applyRecordedSaveScriptFlags(
  session: SessionState,
  flags: CommandFlags,
  hostCwd: string,
): void {
  if (!flags.saveScript) return;
  if (isAuthoringAborted(publicationState(session))) return;
  const requested = {
    path:
      typeof flags.saveScript === 'string'
        ? expandSessionPath(flags.saveScript, hostCwd)
        : undefined,
    force: flags.force === true,
  };
  const state = publicationState(session);
  if (state.kind === 'repair') {
    session.scriptPublication = armRepair(state, {
      requested,
      boundary: state.boundary,
      sourcePath: state.sourcePath,
    });
    return;
  }
  if (state.kind === 'authoring') {
    session.scriptPublication = {
      ...state,
      target: resolveScriptTarget(state.target, requested),
    };
    return;
  }
  session.scriptPublication = armAuthoring(requested);
}

/**
 * Retarget for active publication (`session save-script <path>`), same #1258 rule; a live
 * `--force` re-grants for the (possibly new) target.
 */
export function retargetActivePublication(
  session: SessionState,
  params: { explicitPath?: string; liveForce: boolean | undefined },
  hostCwd: string,
): void {
  const state = publicationState(session);
  if (state.kind !== 'authoring') return;
  session.scriptPublication = {
    ...state,
    target: resolveScriptTarget(state.target, {
      path:
        params.explicitPath !== undefined
          ? expandSessionPath(params.explicitPath, hostCwd)
          : undefined,
      force: params.liveForce === true,
    }),
  };
}

/** How a remote caller receives this session's script, if the recording was armed remotely. */
export function remoteScriptDelivery(
  session: SessionState | undefined,
): RemoteScriptDelivery | undefined {
  const state = publicationState(session);
  return state.kind === 'authoring' ? state.remoteDelivery : undefined;
}

/** Active publication succeeded: PUBLISHED is terminal, which is what stops recording. */
export function markActivePublicationDone(session: SessionState, writtenPath: string): void {
  session.scriptPublication = markAuthoringPublished(publicationState(session), writtenPath);
}

/** Ordinary close publication succeeded: the authoring lifecycle reached `published`. */
export function markCloseGeneratedPublicationDone(
  session: SessionState,
  writtenPath: string,
): void {
  const state = publicationState(session);
  if (state.kind !== 'authoring') return;
  session.scriptPublication = markAuthoringPublished(state, writtenPath);
}

/**
 * The effective overwrite decision at a write site (#1258): a live `--force` on this request, or
 * the per-target grant persisted at arm time.
 */
export function effectiveWriteForce(
  session: SessionState,
  liveForce: boolean | undefined,
): boolean {
  return liveForce === true || scriptTargetForce(publicationState(session));
}

/** A committed/published session's second write must no-op rather than republish. */
export function isSessionScriptPublished(session: SessionState): boolean {
  return isScriptPublished(publicationState(session));
}

/**
 * The outcome of one script version of a remote recording: the daemon file the caller downloads,
 * or why the version could not be written.
 */
type RemoteScriptVersion =
  | Readonly<{ path: string }>
  | Readonly<{
      failure: Readonly<{ message: string; hint: string; cause?: string }>;
    }>;

/** What a close delivers for a remote recording: the recording it ended and its final version. */
export type RemoteCloseScript = Readonly<{
  delivery: RemoteScriptDelivery;
  version?: RemoteScriptVersion;
}>;

/** Numbers the next version of a remote recording, so the caller keeps the newest one. */
function stampNextRevision(session: SessionState): RemoteScriptDelivery | undefined {
  const state = session.scriptPublication;
  if (state?.kind !== 'authoring' || !state.remoteDelivery) return undefined;
  const remoteDelivery = { ...state.remoteDelivery, revision: state.remoteDelivery.revision + 1 };
  session.scriptPublication = { ...state, remoteDelivery };
  return remoteDelivery;
}

/**
 * Adds one script version of a remote recording to a successful response. The artifact carries the
 * publication ID and its revision, so the caller writes it only to the destination it recorded and
 * keeps the newest version. It registers for the tenant that opened the recording, whoever sent
 * this request. A failed version keeps the response successful and carries a typed
 * `scriptDeliveryFailure` with the same publication ID and a warning.
 */
function withRemoteScriptVersion(
  response: DaemonResponse,
  delivery: RemoteScriptDelivery,
  version: RemoteScriptVersion,
): DaemonResponse {
  if (!response.ok) return response;
  const { publicationId } = delivery;
  const data = response.data ?? {};
  if ('failure' in version) {
    const failure: ScriptDeliveryFailure = {
      reason: 'script_delivery_failed',
      publicationId,
      ...version.failure,
    };
    return {
      ok: true,
      data: {
        ...data,
        scriptDeliveryFailure: failure,
        warnings: [...readResponseWarnings(data), `${failure.message} ${failure.hint}`],
      },
    };
  }
  const artifact = asDaemonDeliveredArtifact(
    {
      field: 'savedScript',
      artifactType: 'session-script',
      path: version.path,
      fileName: path.basename(version.path),
      scriptPublicationId: publicationId,
      scriptRevision: delivery.revision,
    },
    delivery.tenantId,
  );
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  return { ok: true, data: { ...data, artifacts: [...artifacts, artifact] } };
}

/**
 * Captures the session's action count before a request. A successful request that then recorded
 * into a remote armed session returns the new script version. When that version cannot be written,
 * the action keeps its success and the response discloses the failed delivery.
 */
export function remoteScriptVersionDelivery(
  sessionStore: SessionStore,
  sessionName: string,
): (response: DaemonResponse) => DaemonResponse {
  const before = sessionStore.lookup(sessionName)?.session;
  const actionCountBefore = before && remoteScriptDelivery(before) ? before.actions.length : 0;
  return (response) => {
    if (!response.ok) return response;
    const ref = sessionStore.lookup(sessionName);
    const delivery = remoteScriptDelivery(ref?.session);
    if (!ref || !delivery || ref.session.actions.length === actionCountBefore) return response;
    const result = sessionStore.writeRemoteScriptVersion(ref);
    if (result.written) {
      const stamped = stampNextRevision(ref.session) ?? delivery;
      return withRemoteScriptVersion(response, stamped, { path: result.path });
    }
    if (!result.error) return response;
    // The daemon diagnostic keeps the cause; its daemon-host path stays out of the response. The typed
    // reason travels as the failure's `cause`, so a client can tell which refusal this was (ADR 0016).
    return withRemoteScriptVersion(response, delivery, {
      failure: {
        message: 'The action succeeded, but the daemon could not write the remote recording.',
        hint: 'The --save-script file keeps the previous version. The next recorded action or close delivers the full recording again.',
        ...(typeof result.error.details?.reason === 'string'
          ? { cause: result.error.details.reason }
          : {}),
      },
    });
  };
}

/**
 * Reads what a close of a remote recording delivers from the session that the close-time write
 * just marked, because teardown may have replaced the session object before that write. A
 * published final version is stamped after every earlier version, so it replaces the last one.
 *
 * `writeFailure` is the close write's own error, and its typed reason travels as the failure's
 * `cause`: a close refused for the daemon's state chain is a different recovery than a full disk,
 * and the client sees which without reading prose (ADR 0016).
 */
export function remoteCloseScript(
  session: SessionState,
  writeFailure: AppError | undefined,
): RemoteCloseScript | undefined {
  const state = session.scriptPublication;
  if (state?.kind !== 'authoring' || !state.remoteDelivery) return undefined;
  const delivery = state.remoteDelivery;
  if (writeFailure) {
    const message = 'The session was closed, but the daemon could not write its final script.';
    const hint = 'The --save-script file keeps the version from the last recorded action.';
    const reason = writeFailure.details?.reason;
    return {
      delivery,
      version: {
        failure: {
          message,
          hint,
          ...(typeof reason === 'string' ? { cause: reason } : {}),
        },
      },
    };
  }
  const writtenPath = state.status === 'published' ? scriptTargetPath(state) : undefined;
  if (!writtenPath) return { delivery };
  return { delivery: stampNextRevision(session) ?? delivery, version: { path: writtenPath } };
}

/**
 * A close of a remote recording names the recording it ended, so the caller retires its
 * destination even when close publishes nothing, as for an aborted recording. When close could
 * not write the final version, the close keeps its success and discloses the failed delivery.
 */
export function remoteCloseScriptDelivery(
  response: DaemonResponse,
  close: RemoteCloseScript | undefined,
): DaemonResponse {
  if (!close || !response.ok) return response;
  const named: DaemonResponse = {
    ok: true,
    data: { ...response.data, scriptPublicationId: close.delivery.publicationId },
  };
  return close.version ? withRemoteScriptVersion(named, close.delivery, close.version) : named;
}
