import type { AgentDeviceBackend, BackendSnapshotResult } from '../backend.ts';
import { resolveTargetDevice } from '../core/dispatch.ts';
import { createAgentDevice } from '../runtime.ts';
import { isMacOs, isApplePlatform, publicPlatformString } from '@agent-device/kernel/device';
import { noActiveSessionError, requireCommandSupported } from './handlers/response.ts';
import type { SnapshotState, SnapshotNode } from '@agent-device/kernel/snapshot';
import { findNodeByLabel } from '../core/snapshot-node-lookup.ts';
import { runAppleRunnerCommand } from '../platforms/apple/core/runner/runner-client.ts';
import { buildAppleRunnerRequestOptions } from './apple-runner-options.ts';
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { contextFromFlags } from './context.ts';
import { ensureDeviceReady } from './device-ready.ts';
import { readTextForNode } from './handlers/interaction-read.ts';
import { legacyDispatchReadTextAtPoint } from './handlers/interaction-read-legacy-dispatch.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import type { ContextFromFlags } from './handlers/interaction-common.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { createSelectorCaptureRuntime } from './selector-capture-runtime.ts';
import {
  resolveBoundSelectorCapture,
  type BoundSelectorOperations,
  type SelectorCaptureCommand,
} from './selector-capture-binding.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { getRequestSignal } from '../request/cancel.ts';
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
};

export type SelectorRuntimeDeviceParams = SelectorRuntimeParams & {
  session: SessionState | undefined;
  device: SessionState['device'];
  /** The request-bound operations this runtime executes through. Absent for selector
   * commands still on legacy admission, until their own ADR 0019 unit lands. */
  bound?: BoundSelectorOperations;
};

type ResolvedSelectorRuntime =
  | { ok: true; runtime: ReturnType<typeof createSelectorRuntimeForDevice> }
  | { ok: false; response: DaemonResponse };

type ResolvedSelectorDevice =
  | { ok: true; session: SessionState | undefined; device: SessionState['device'] }
  | { ok: false; response: DaemonResponse };

type AppleRunnerFindTextTarget = {
  device: SessionState['device'];
  appBundleId: string;
  traceLogPath?: string;
};

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
 * A migrated selector command's runtime: facts-first admission, exactly one binding, and a
 * backend whose every capture goes through the bound operation. A sibling unit migrates by
 * naming its command here instead of passing a `capability` to {@link createSelectorRuntime};
 * nothing else in this module or `selector-capture-runtime.ts` needs to change.
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

/**
 * The legacy capability-admitted selector runtime, for the selector commands whose ADR 0019
 * unit has not landed. The union narrows as each one migrates, and the last selector unit
 * deletes this function together with its `requireCommandSupported` call.
 */
export async function createSelectorRuntime(
  params: SelectorRuntimeParams,
  options: { requireSession: boolean; capability: 'find' | 'is' },
): Promise<ResolvedSelectorRuntime> {
  const resolved = await resolveSelectorRuntimeDevice(params, options.requireSession);
  if (!resolved.ok) return resolved;
  const unsupported = requireCommandSupported(options.capability, resolved.device);
  if (unsupported) return { ok: false, response: unsupported };
  return {
    ok: true,
    runtime: createSelectorRuntimeForDevice({
      ...params,
      session: resolved.session,
      device: resolved.device,
    }),
  };
}

function createSelectorBackend(params: SelectorRuntimeDeviceParams): AgentDeviceBackend {
  // Which read the backend uses is fixed by WHICH COMMAND CONSTRUCTED THIS RUNTIME, never by
  // failure, family, environment, or flag. A migrated command arrives with `bound` and its
  // binding is authoritative — including when the owner advertised no read, which is the complete
  // required path. An unmigrated selector command arrives without `bound` and keeps the legacy
  // dispatch until its own descriptor cuts over (ADR 0019 §6 permits the unmigrated sibling's own
  // path); a migrated command can never reach it.
  const { req, session, device, logPath, sessionName, sessionStore } = params;
  const resolveContextFromFlags: ContextFromFlags =
    params.contextFromFlags ??
    ((flags, appBundleId, traceLogPath) =>
      contextFromFlags(logPath ?? '', flags, appBundleId, traceLogPath));
  const readTextAtPoint = params.bound
    ? params.bound.readText
    : legacyDispatchReadTextAtPoint({
        device,
        flags: req.flags,
        surface: session?.surface,
        contextFromFlags: resolveContextFromFlags,
      });
  const captureRuntime = createSelectorCaptureRuntime({
    device,
    session,
    sessionStore,
    sessionName,
    req,
    consumedSnapshot: params.consumedSnapshot,
    logPath,
    capture: params.bound?.capture,
  });
  return {
    platform: publicPlatformString(device),
    captureSnapshot: async (context, options): Promise<BackendSnapshotResult> => {
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
    },
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
    findText: async (context, text) => ({
      found: await findText(params, text, context.signal),
    }),
  };
}

async function findText(
  params: SelectorRuntimeDeviceParams,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const macosSurfaceResult = await findTextInMacosNonAppSurface(params, text, signal);
  if (macosSurfaceResult !== null) return macosSurfaceResult;
  const appleRunnerResult = await findTextWithAppleRunner(params, text, signal);
  // The runner query is a fast path, not the semantic source of truth. XCTest can report a
  // transient miss for visible SwiftUI text that the canonical snapshot already contains.
  if (appleRunnerResult === true) return true;
  return await findTextInWaitSnapshot(params, text, signal);
}

async function findTextInMacosNonAppSurface(
  params: SelectorRuntimeDeviceParams,
  text: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  if (!isMacOs(params.device)) return null;
  if (!params.session?.surface || params.session.surface === 'app') return null;
  return await findTextInWaitSnapshot(params, text, signal);
}

async function findTextWithAppleRunner(
  params: SelectorRuntimeDeviceParams,
  text: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const target = readAppleRunnerFindTextTarget(params);
  if (!target) return null;
  const result = (await runAppleRunnerCommand(
    target.device,
    { command: 'findText', text, appBundleId: target.appBundleId },
    { ...buildAppleRunnerFindTextOptions(params, target), signal },
  )) as { found?: boolean };
  return result?.found === true;
}

function readAppleRunnerFindTextTarget(
  params: SelectorRuntimeDeviceParams,
): AppleRunnerFindTextTarget | null {
  if (!isApplePlatform(params.device.platform)) return null;
  if (isActiveProviderDevice(params.device)) return null;
  if (!params.session?.appBundleId) return null;
  return {
    device: params.device,
    appBundleId: params.session.appBundleId,
    traceLogPath: params.session.trace?.outPath,
  };
}

function buildAppleRunnerFindTextOptions(
  params: SelectorRuntimeDeviceParams,
  target: AppleRunnerFindTextTarget,
) {
  return buildAppleRunnerRequestOptions({
    req: params.req,
    logPath: params.logPath,
    traceLogPath: target.traceLogPath,
  });
}

async function findTextInWaitSnapshot(
  params: SelectorRuntimeDeviceParams,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const snapshot = await captureWaitSnapshot(params, signal);
  return Boolean(findNodeByLabel(snapshot.nodes, text));
}

async function captureWaitSnapshot(params: SelectorRuntimeDeviceParams, signal?: AbortSignal) {
  const captureRuntime = createSelectorCaptureRuntime({
    device: params.device,
    session: params.session,
    sessionStore: params.sessionStore,
    sessionName: params.sessionName,
    req: params.req,
    logPath: params.logPath,
    consumedSnapshot: params.consumedSnapshot,
  });
  const { snapshot } = await captureRuntime.capture({
    flags: {
      ...params.req.flags,
      snapshotInteractiveOnly: false,
      // Presence-only wait poll (findText is only called from waitForText):
      // skip scroll-hint derivation (#1270).
      snapshotIncludeHiddenContentHints: false,
    },
    signal,
    cache: {
      forceFresh: true,
      bypassForPostGestureStabilization: true,
    },
  });
  return snapshot;
}
