import type {
  AgentDeviceBackend,
  BackendCommandContext,
  BackendSnapshotResult,
} from '../backend.ts';
import { resolveTargetDevice } from '../core/dispatch-resolve.ts';
import { createAgentDevice } from '../runtime.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
import { noActiveSessionError } from './response.ts';
import type { SnapshotState, SnapshotNode } from '@agent-device/kernel/snapshot';
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { contextFromFlags } from './context.ts';
import { ensureDeviceReady } from './device-ready.ts';
import { readTextForNode } from './handlers/interaction-read.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import type { ContextFromFlags } from './handlers/interaction-common.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { createSelectorCaptureRuntime } from './selector-capture-runtime.ts';
import { buildRuntimeCaptureInput } from './snapshot-runtime-capture-input.ts';
import {
  resolveBoundSelectorCapture,
  type BoundSelectorOperations,
  type SelectorCaptureCommand,
} from './selector-capture-binding.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { snapshotOptionsToFlags } from '../backend-snapshot-options.ts';

export type SelectorRuntimeParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags?: ContextFromFlags;
  // Filled by the capture runtime with the snapshot each selector command actually consumed;
  // sessionless routes disclose from here because no session record stores the capture.
  consumedSnapshot?: { state?: SnapshotState };
  signal?: AbortSignal;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  androidObservation?: AndroidObservationAdapter;
  platformResourceCleanup?: PlatformResourceCleanup;
};

export type SelectorRuntimeDeviceParams = SelectorRuntimeParams & {
  session: SessionState | undefined;
  device: SessionState['device'];
  /**
   * The request-bound operations this runtime executes through. Required to STATE since find
   * (R35): every selector command admits before it constructs this runtime, and the only
   * declared absence is the observation-free duration wait (`wait 400`), which never captures —
   * its runtime carries no capture backend at all, so an accidental capture fails loudly.
   */
  bound: BoundSelectorOperations | undefined;
};

type ResolvedSelectorRuntime =
  | { ok: true; runtime: ReturnType<typeof createSelectorRuntimeForDevice> }
  | { ok: false; response: DaemonResponse };

type ResolvedSelectorDevice =
  | { ok: true; session: SessionState | undefined; device: SessionState['device'] }
  | { ok: false; response: DaemonResponse };

export function createSelectorRuntimeForDevice(params: SelectorRuntimeDeviceParams) {
  return createAgentDevice({
    backend: createSelectorBackend(params),
    ...createDaemonRuntimePolicy('selector commands', { plural: true }),
    sessions: createDaemonRuntimeSessionStore({
      sessionName: params.sessionName,
      getSession: () => params.session,
      recordOptions: { includeSnapshot: true },
      setRecord: (record) => {
        if (!params.session || !record.snapshot) return;
        setSessionSnapshot(params.session, record.snapshot);
        params.sessionStore.set(params.sessionName, params.session);
      },
    }),
    signal: params.signal ?? getRequestSignal(params.req.meta?.requestId),
  });
}

/** The session/device a selector command runs against, before any admission decides. */
async function resolveSelectorRuntimeDevice(
  params: SelectorRuntimeParams,
  requireSession: boolean,
): Promise<ResolvedSelectorDevice> {
  params.consumedSnapshot ??= {};
  const session = params.sessionStore.get(params.sessionName);
  if (!session && requireSession) return { ok: false, response: noActiveSessionError() };
  const device = session?.device ?? (await resolveTargetDevice(params.req.flags ?? {}));
  if (!session) await ensureDeviceReady(device);
  return { ok: true, session, device };
}

/**
 * THE selector runtime: facts-first admission, exactly one binding, and a backend whose every
 * capture goes through the bound operation. Since `is` (R37) there is no other one — the legacy
 * capability-admitted `createSelectorRuntime` and its `requireCommandSupported` call were its
 * last consumer and retired with it, so a selector command cannot reach the device on a
 * capability bucket even by mistake.
 *
 * ADR 0019 §6: a `device-runtime` command reaches the device only after resolve -> admit ->
 * bind, so THIS CALL COMES FIRST in its route — ahead of every shortcut, including the
 * direct-iOS selector query that answers some targets without a capture. That query is a fast
 * path *within* an admitted request, never a way around exact-owner facts or the one-binding
 * invariant. `get` (R36) and `is` (R37) both order it this way.
 */
export async function createBoundSelectorRuntime(
  params: SelectorRuntimeParams,
  options: { requireSession: boolean; command: SelectorCaptureCommand },
): Promise<ResolvedSelectorRuntime> {
  const resolved = await resolveSelectorRuntimeDevice(params, options.requireSession);
  if (!resolved.ok) return resolved;
  const bound = await resolveBoundSelectorCapture({
    command: options.command,
    device: resolved.device,
    session: resolved.session,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return { ok: false, response: bound.response };
  return {
    ok: true,
    runtime: createSelectorRuntimeForDevice({
      ...params,
      session: resolved.session,
      device: resolved.device,
      bound: bound.operations,
    }),
  };
}

function createSelectorBackend(params: SelectorRuntimeDeviceParams): AgentDeviceBackend {
  // The bound operation is the ONLY element read. Both consumers of the shared backend read —
  // `get text` and read-only `find … get text` — construct a bound backend, so there is no second
  // read path to choose between and nothing reaches the retired `read` dispatch.
  const { req, session, device, logPath, sessionName, sessionStore } = params;
  const resolveContextFromFlags: ContextFromFlags =
    params.contextFromFlags ??
    ((flags, appBundleId, traceLogPath) =>
      contextFromFlags(logPath ?? '', flags, appBundleId, traceLogPath));
  const readTextAtPoint = params.bound?.readText;
  const boundFindText = params.bound?.findText;
  // The native reading must run in the SAME runner context as the capture it short-circuits:
  // one requestId so diagnostics land in one request file, the session's log/trace paths, and
  // the XCUITest override + runner-lease context the caller configured. Built through the one
  // capture-intent builder the capture leg uses, never a second hand-rolled context.
  const runnerExecution = buildRuntimeCaptureInput({
    flags: req.flags,
    logPath: logPath ?? '',
    meta: req.meta,
    session,
    snapshotScope: undefined,
  }).execution;
  const boundOperations = params.bound;
  const captureRuntime =
    boundOperations === undefined
      ? undefined
      : createSelectorCaptureRuntime({
          device,
          session,
          sessionStore,
          sessionName,
          req,
          consumedSnapshot: params.consumedSnapshot,
          logPath,
          capture: boundOperations.capture,
        });
  return {
    platform: publicPlatformString(device),
    captureSnapshot:
      captureRuntime &&
      (async (context, options): Promise<BackendSnapshotResult> => {
        const flags = {
          ...req.flags,
          ...snapshotOptionsToFlags(options),
        };
        const includeRects = options?.includeRects === true;
        const snapshotScope = options?.scope ?? req.flags?.snapshotScope;
        const needsFreshSnapshot =
          req.command === 'wait' ||
          req.command === 'find' ||
          (includeRects && device.platform === 'web');
        return await captureRuntime.capture({
          flags,
          signal: context.signal,
          snapshotScope,
          includeRects,
          cache: {
            forceFresh: needsFreshSnapshot,
            useSessionSnapshot: true,
            bypassForPostGestureStabilization: true,
          },
        });
      }),
    readText: async (_context, node: SnapshotNode) => ({
      text: await readTextForNode({
        readTextAtPoint,
        device,
        node,
        flags: req.flags,
        appBundleId: session?.appBundleId,
        traceOutPath: session?.trace?.outPath,
        surface: session?.surface,
        contextFromFlags: resolveContextFromFlags,
      }),
    }),
    // The owner's native text reading, forwarded only when its facts advertised it. The daemon
    // makes no family, provider, surface, or session decision here: an owner that cannot answer
    // reports `found: false` and the poll consults the canonical tree.
    ...(boundFindText
      ? {
          findText: async (context: BackendCommandContext, text: string) => ({
            found: (
              await boundFindText({
                text,
                options: { appBundleId: session?.appBundleId, surface: session?.surface },
                execution: runnerExecution,
                ...(context.signal ? { signal: context.signal } : {}),
              })
            ).found,
          }),
        }
      : {}),
  };
}
