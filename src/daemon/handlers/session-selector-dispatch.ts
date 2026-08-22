import { dispatchCommand } from '../../core/dispatch.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import { requireSessionOrExplicitSelector, resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { resolveBoundKeyboardRuntime } from '../keyboard-runtime.ts';
import { resolveRefFrameEffect } from '../daemon-command-registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import {
  resolveAndroidPackageForOpen,
  resolveSessionAppBundleIdForTarget,
} from '../../platform-runtime-open-target.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';

/**
 * What `runSessionOrSelectorDispatch`'s `prepare` thunk reports: either the early-exit response an
 * admission refusal produces (nothing mutated yet, so the frame stays untouched), or the
 * invocation to run once the ref frame is expired. Splitting admission/preparation from invocation
 * lets the frame expire immediately before the mutating call (ADR 0014) regardless of whether that
 * call later succeeds, rejects, or times out — there is no success-only rollback.
 */
type SessionCommandPrepareOutcome =
  | Readonly<{ ok: false; response: DaemonResponse }>
  | Readonly<{ ok: true; execute: () => Promise<Record<string, unknown> | void> }>;

/**
 * The one orchestration every session/selector-route leaf shares: guard, resolve the device,
 * admit-then-prepare via the caller's own strategy, expire the ref frame if the command mutates
 * (immediately before the prepared invocation runs, never after), derive and record the next
 * session. `prepare` is where the two strategies session-route commands use today diverge —
 * {@link legacySessionDispatchExecute} for a still-legacy command (capability gate, then
 * `dispatchCommand`), or a bind-and-execute thunk like `keyboard`'s below for a migrated one —
 * everything around it is identical either way, so it lives here once instead of once per command.
 */
// fallow-ignore-next-line complexity
async function runSessionOrSelectorDispatch(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  command: string;
  positionals: string[];
  recordPositionals?: string[];
  deriveNextSession?: (
    session: SessionState,
    result: Record<string, unknown> | void,
    device: DeviceInfo,
  ) => Promise<SessionState> | SessionState;
  prepare: (
    device: DeviceInfo,
    session: SessionState | undefined,
  ) => Promise<SessionCommandPrepareOutcome>;
}): Promise<DaemonResponse> {
  const {
    req,
    sessionName,
    sessionStore,
    command,
    positionals,
    recordPositionals,
    deriveNextSession,
    prepare,
  } = params;
  const session = sessionStore.get(sessionName);
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(command, session, flags);
  if (guard) return guard;

  const device = await resolveCommandDevice({
    session,
    flags,
    ensureReady: true,
  });
  const prepared = await prepare(device, session);
  if (!prepared.ok) return prepared.response;

  // ADR 0014 side-effect seam for session/selector-route leaves (keyboard
  // dismiss/enter/return, push, trigger-app-event). Expire the frame immediately before the
  // mutating invocation runs — not after it resolves — when the classification says this
  // request mutates; keyboard status/get resolve to `preserve` and leave the frame untouched.
  if (session && resolveRefFrameEffect(req) === 'may-invalidate') {
    expireRefFrame(session);
  }

  const result = await prepared.execute();

  if (session) {
    const nextSession = deriveNextSession
      ? await deriveNextSession(session, result, device)
      : session;
    recordSessionAction(sessionStore, nextSession, req, command, result ?? {}, {
      positionals: recordPositionals ?? positionals,
    });
    if (nextSession !== session) {
      sessionStore.set(sessionName, nextSession);
    }
  }
  return { ok: true, data: result ?? {} };
}

/** The still-legacy `prepare` thunk: the capability gate is admission (nothing mutated yet if it
 * refuses); `dispatchCommand` is the invocation, deferred until `runSessionOrSelectorDispatch` has
 * expired the ref frame. Every remaining unmigrated session-route command passes this until its
 * own migration replaces it with a bind-and-execute thunk, same as `keyboard`'s
 * {@link handleKeyboardCommand} below. */
function legacySessionDispatchExecute(
  command: string,
  positionals: string[],
  req: DaemonRequest,
  logPath: string,
): (
  device: DeviceInfo,
  session: SessionState | undefined,
) => Promise<SessionCommandPrepareOutcome> {
  return async (device, session) => {
    const unsupported = requireCommandSupported(command, device);
    if (unsupported) return { ok: false, response: unsupported };
    return {
      ok: true,
      execute: () =>
        dispatchCommand(device, command, positionals, req.flags?.out, {
          ...contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
        }),
    };
  };
}

/**
 * A dismiss/enter/return sent with no session and no explicit iOS selector would target whatever
 * app happens to be foreground on a later-resolved device, silently. Refuse it up front rather
 * than let admission and binding run against a target the caller never named.
 */
function requireForegroundIosKeyboardSession(
  session: SessionState | undefined,
  keyboardAction: string | undefined,
  flags: DaemonRequest['flags'],
): DaemonResponse | undefined {
  const needsForegroundIosApp =
    keyboardAction === 'dismiss' || keyboardAction === 'enter' || keyboardAction === 'return';
  if (session || !needsForegroundIosApp || flags?.platform !== 'ios') return undefined;
  return errorResponse(
    'SESSION_NOT_FOUND',
    'iOS keyboard action requires an active session so the target app stays foregrounded. Run open first.',
  );
}

/**
 * `keyboard`'s migrated `prepare` thunk (ADR 0019 §9): bind whichever action-selected use the
 * parsed action names — admission only, no device I/O yet — and defer the bound runtime's own
 * `execute` as the invocation `runSessionOrSelectorDispatch` runs after expiring the frame.
 * Replaces the resolve-then-record shape `runSessionOrSelectorDispatch` now owns — this only
 * supplies what the generic route's `dispatchCommand` cannot: the bound runtime and the
 * action-specific execution context.
 */
function keyboardSessionExecute(
  positionals: string[],
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
  bindDevice: BindDeviceRuntime | undefined,
  req: DaemonRequest,
  logPath: string,
): (
  device: DeviceInfo,
  session: SessionState | undefined,
) => Promise<SessionCommandPrepareOutcome> {
  return async (device, session) => {
    const bound = await resolveBoundKeyboardRuntime({
      device,
      positionals,
      inspectFacts,
      bindDevice,
    });
    if (!bound.ok) return { ok: false, response: bound.response };
    const dispatchContext = {
      ...contextFromFlags(logPath, req.flags, session?.appBundleId, session?.trace?.outPath),
      surface: session?.surface,
    };
    return { ok: true, execute: () => bound.execute(dispatchContext) };
  };
}

export async function handleKeyboardCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, inspectFacts, bindDevice } = params;
  const positionals = req.positionals ?? [];

  const foregroundGuard = requireForegroundIosKeyboardSession(
    sessionStore.get(sessionName),
    positionals[0]?.trim().toLowerCase(),
    req.flags ?? {},
  );
  if (foregroundGuard) return foregroundGuard;

  return await runSessionOrSelectorDispatch({
    req,
    sessionName,
    sessionStore,
    command: PUBLIC_COMMANDS.keyboard,
    positionals,
    prepare: keyboardSessionExecute(positionals, inspectFacts, bindDevice, req, logPath),
  });
}

export async function handleTriggerAppEventCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  const positionals = req.positionals ?? [];
  return await runSessionOrSelectorDispatch({
    req,
    sessionName,
    sessionStore,
    command: PUBLIC_COMMANDS.triggerAppEvent,
    positionals,
    prepare: legacySessionDispatchExecute(
      PUBLIC_COMMANDS.triggerAppEvent,
      positionals,
      req,
      logPath,
    ),
    deriveNextSession: async (session, result) => {
      const eventUrl = typeof result?.eventUrl === 'string' ? result.eventUrl : undefined;
      const nextAppBundleId = eventUrl
        ? ((await resolveSessionAppBundleIdForTarget(
            session.device,
            eventUrl,
            session.appBundleId,
            resolveAndroidPackageForOpen,
          )) ?? session.appBundleId)
        : session.appBundleId;
      return {
        ...session,
        appBundleId: nextAppBundleId,
      };
    },
  });
}
