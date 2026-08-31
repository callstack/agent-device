import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
} from '../session-device-resolution.ts';
import { errorResponse } from '../response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { resolveBoundAppEventRuntime } from '../app-event-runtime.ts';
import { resolveBoundKeyboardRuntime } from '../keyboard-runtime.ts';
import { resolveRefFrameEffect } from '../daemon-command-registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import {
  resolveAndroidPackageForOpen,
  resolveSessionAppBundleIdForTarget,
} from '../../platform-runtime-open-target.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { DaemonCommandContext } from '../context.ts';

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
 * session. `prepare` is where each leaf's own admission and binding lives; everything around it
 * is identical, so it lives here once instead of once per command. Every leaf on this route now
 * supplies a bind-and-execute thunk — R57 retired the last capability-gate-then-`dispatchCommand`
 * one with `trigger-app-event`.
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

/** The params every migrated session-route handler takes; identical across the leaves. */
type SessionRouteHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}>;

type SessionRouteRuntimeResolver = (
  params: Readonly<{
    device: DeviceInfo;
    positionals: string[];
    inspectFacts?: InspectDeviceRuntimeFacts;
    bindDevice?: BindDeviceRuntime;
  }>,
) => Promise<
  | Readonly<{ ok: false; response: DaemonResponse }>
  | Readonly<{
      ok: true;
      execute: (context: DaemonCommandContext) => Promise<Record<string, unknown> | void>;
    }>
>;

/**
 * The whole shape a migrated session-route leaf needs: admit and bind through the caller's own
 * resolver, then hand `runSessionOrSelectorDispatch` the bound runtime's `execute` to invoke after
 * expiring the frame. Only the resolver, the command name and the optional session derivation
 * differ per leaf, so one entry point here is what keeps `keyboard` and `trigger-app-event` from
 * drifting into two copies of the same wiring.
 */
async function runBoundSessionRoute(
  params: SessionRouteHandlerParams &
    Readonly<{
      command: string;
      /**
       * Written as a call at each leaf rather than passed by reference: the resolver call site is
       * this command's own single-bind evidence (ADR 0019 §9), and the cutover gate reads it
       * lexically. A bare reference would dedupe the wiring and delete the proof with it.
       */
      resolveRuntime: SessionRouteRuntimeResolver;
      deriveNextSession?: Parameters<typeof runSessionOrSelectorDispatch>[0]['deriveNextSession'];
    }>,
): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, inspectFacts, bindDevice } = params;
  const positionals = req.positionals ?? [];
  return await runSessionOrSelectorDispatch({
    req,
    sessionName,
    sessionStore,
    command: params.command,
    positionals,
    ...(params.deriveNextSession ? { deriveNextSession: params.deriveNextSession } : {}),
    prepare: async (device, session) => {
      const bound = await params.resolveRuntime({
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
    },
  });
}

export async function handleKeyboardCommand(
  params: SessionRouteHandlerParams,
): Promise<DaemonResponse> {
  const foregroundGuard = requireForegroundIosKeyboardSession(
    params.sessionStore.get(params.sessionName),
    params.req.positionals?.[0]?.trim().toLowerCase(),
    params.req.flags ?? {},
  );
  if (foregroundGuard) return foregroundGuard;
  return await runBoundSessionRoute({
    ...params,
    command: PUBLIC_COMMANDS.keyboard,
    resolveRuntime: (runtimeParams) => resolveBoundKeyboardRuntime(runtimeParams),
  });
}

export async function handleAppEventCommand(
  params: SessionRouteHandlerParams,
): Promise<DaemonResponse> {
  return await runBoundSessionRoute({
    ...params,
    command: PUBLIC_COMMANDS.triggerAppEvent,
    resolveRuntime: (runtimeParams) => resolveBoundAppEventRuntime(runtimeParams),
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
