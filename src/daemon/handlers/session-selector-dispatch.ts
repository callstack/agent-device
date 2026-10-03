import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import type { SessionRef, SessionState } from '../session-state.ts';
import type { SessionStore } from '../session-store.ts';
import { contextFromFlags } from '../context.ts';
import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
} from '../session-device-resolution.ts';
import { recordSessionAction } from '../session-action-recorder.ts';
import { resolveBoundAppEventRuntime } from '../app-event-runtime.ts';
import { resolveBoundKeyboardRuntime } from '../keyboard-runtime.ts';
import { resolveRefFrameEffect } from '../daemon-command-registry.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { resolveSessionAppBundleIdForTarget } from '../../platform-runtime-open-target.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { DaemonCommandContext } from '../context.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

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
 * (immediately before the prepared invocation runs, never after), apply the optional session
 * patch and record the action. `prepare` owns each leaf's admission and binding; the shared
 * orchestration lives here once. Every leaf on this route now
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
  updateSession?: (ref: SessionRef, result: Record<string, unknown> | void) => Promise<void> | void;
  prepare: (
    device: DeviceInfo,
    ref: SessionRef | undefined,
  ) => Promise<SessionCommandPrepareOutcome>;
}): Promise<DaemonResponse> {
  const {
    req,
    sessionName,
    sessionStore,
    command,
    positionals,
    recordPositionals,
    updateSession,
    prepare,
  } = params;
  const ref = sessionStore.lookup(sessionName);
  const session = ref?.session;
  const flags = req.flags ?? {};
  const guard = requireSessionOrExplicitSelector(command, session, flags);
  if (guard) return guard;

  const device = await resolveCommandDevice({
    session,
    flags,
  });
  if (ref) sessionStore.requireCurrent(ref);
  const prepared = await prepare(device, ref);
  if (!prepared.ok) return prepared.response;

  // ADR 0014 side-effect seam for session/selector-route leaves (keyboard
  // dismiss/enter/return, push, trigger-app-event). Expire the frame immediately before the
  // mutating invocation runs — not after it resolves — when the classification says this
  // request mutates; keyboard status/get resolve to `preserve` and leave the frame untouched.
  const current = ref ? sessionStore.requireCurrent(ref) : undefined;
  if (current && resolveRefFrameEffect(req) === 'may-invalidate') {
    expireRefFrame(current);
  }

  const result = await prepared.execute();

  if (ref) {
    if (updateSession) await updateSession(ref, result);
    recordSessionAction(sessionStore, ref, req, command, result ?? {}, {
      positionals: recordPositionals ?? positionals,
    });
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
    readiness?: boolean;
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
 * expiring the frame. Only the resolver, the command name and the optional post-execution session patch
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
      updateSession?: Parameters<typeof runSessionOrSelectorDispatch>[0]['updateSession'];
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
    ...(params.updateSession ? { updateSession: params.updateSession } : {}),
    prepare: async (device, ref) => {
      const bound = await params.resolveRuntime({
        device,
        positionals,
        readiness: true,
        inspectFacts,
        bindDevice,
      });
      if (!bound.ok) return { ok: false, response: bound.response };
      const session = ref ? sessionStore.requireCurrent(ref) : undefined;
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
    updateSession: async (ref, result) => {
      const eventUrl = typeof result?.eventUrl === 'string' ? result.eventUrl : undefined;
      if (!eventUrl) return;
      const session = params.sessionStore.requireCurrent(ref);
      const appBundleId = await resolveSessionAppBundleIdForTarget(
        session.device,
        eventUrl,
        session.appBundleId,
      );
      if (appBundleId !== undefined) params.sessionStore.update(ref, { appBundleId });
    },
  });
}
