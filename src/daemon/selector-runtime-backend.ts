import type {
  AgentDeviceBackend,
  BackendSnapshotOptions,
  BackendSnapshotResult,
} from '../backend.ts';
import { resolveTargetDevice, type CommandFlags } from '../core/dispatch.ts';
import { createAgentDevice } from '../runtime.ts';
import { isApplePlatform } from '../kernel/device.ts';
import { noActiveSessionError, requireCommandSupported } from './handlers/response.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { findNodeByLabel } from '../snapshot/snapshot-processing.ts';
import { runIosRunnerCommand } from '../platforms/apple/core/runner/runner-client.ts';
import { buildAppleRunnerRequestOptions } from './apple-runner-options.ts';
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

export type SelectorRuntimeParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags?: ContextFromFlags;
};

type SelectorRuntimeDeviceParams = SelectorRuntimeParams & {
  session: SessionState | undefined;
  device: SessionState['device'];
};

type AppleRunnerFindTextTarget = {
  device: SessionState['device'];
  appBundleId: string;
  traceLogPath?: string;
};

type SnapshotFlagOverrides = Partial<
  Pick<CommandFlags, 'snapshotInteractiveOnly' | 'snapshotScope' | 'snapshotDepth' | 'snapshotRaw'>
>;

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
  });
}

export async function createSelectorRuntime(
  params: SelectorRuntimeParams,
  options: { requireSession: boolean; capability: 'find' | 'get' | 'is' },
): Promise<
  | { ok: true; runtime: ReturnType<typeof createSelectorRuntimeForDevice> }
  | { ok: false; response: DaemonResponse }
> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session && options.requireSession) {
    return {
      ok: false,
      response: noActiveSessionError(),
    };
  }
  const device = session?.device ?? (await resolveTargetDevice(params.req.flags ?? {}));
  if (!session) await ensureDeviceReady(device);
  const unsupported = requireCommandSupported(options.capability, device);
  if (unsupported) return { ok: false, response: unsupported };
  return {
    ok: true,
    runtime: createSelectorRuntimeForDevice({
      ...params,
      session,
      device,
    }),
  };
}

function createSelectorBackend(params: SelectorRuntimeDeviceParams): AgentDeviceBackend {
  const { req, session, device, logPath, sessionName, sessionStore } = params;
  const captureRuntime = createSelectorCaptureRuntime({
    device,
    session,
    sessionStore,
    sessionName,
    req,
    logPath,
  });
  return {
    platform: device.platform,
    captureSnapshot: async (_context, options): Promise<BackendSnapshotResult> => {
      const flags = {
        ...req.flags,
        ...snapshotFlagOverrides(options),
      };
      const includeRects = options?.includeRects === true;
      const snapshotScope = options?.scope ?? req.flags?.snapshotScope;
      const needsFreshSnapshot =
        req.command === 'wait' ||
        req.command === 'find' ||
        (includeRects && device.platform === 'web');
      return await captureRuntime.capture({
        flags,
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
        device,
        node,
        flags: req.flags,
        appBundleId: session?.appBundleId,
        traceOutPath: session?.trace?.outPath,
        surface: session?.surface,
        contextFromFlags:
          params.contextFromFlags ??
          ((flags, appBundleId, traceLogPath) =>
            contextFromFlags(logPath ?? '', flags, appBundleId, traceLogPath)),
      }),
    }),
    findText: async (_context, text) => ({
      found: await findText(params, text),
    }),
  };
}

function snapshotFlagOverrides(options: BackendSnapshotOptions | undefined): SnapshotFlagOverrides {
  const flags: SnapshotFlagOverrides = {};
  if (options?.interactiveOnly !== undefined)
    flags.snapshotInteractiveOnly = options.interactiveOnly;
  if (options?.scope !== undefined) flags.snapshotScope = options.scope;
  if (options?.depth !== undefined) flags.snapshotDepth = options.depth;
  if (options?.raw !== undefined) flags.snapshotRaw = options.raw;
  return flags;
}

async function findText(params: SelectorRuntimeDeviceParams, text: string): Promise<boolean> {
  const macosSurfaceResult = await findTextInMacosNonAppSurface(params, text);
  if (macosSurfaceResult !== null) return macosSurfaceResult;
  const appleRunnerResult = await findTextWithAppleRunner(params, text);
  if (appleRunnerResult !== null) return appleRunnerResult;
  return await findTextInWaitSnapshot(params, text);
}

async function findTextInMacosNonAppSurface(
  params: SelectorRuntimeDeviceParams,
  text: string,
): Promise<boolean | null> {
  if (params.device.platform !== 'macos') return null;
  if (!params.session?.surface || params.session.surface === 'app') return null;
  return await findTextInWaitSnapshot(params, text);
}

async function findTextWithAppleRunner(
  params: SelectorRuntimeDeviceParams,
  text: string,
): Promise<boolean | null> {
  const target = readAppleRunnerFindTextTarget(params);
  if (!target) return null;
  const result = (await runIosRunnerCommand(
    target.device,
    { command: 'findText', text, appBundleId: target.appBundleId },
    buildAppleRunnerFindTextOptions(params, target),
  )) as { found?: boolean };
  return result?.found === true;
}

function readAppleRunnerFindTextTarget(
  params: SelectorRuntimeDeviceParams,
): AppleRunnerFindTextTarget | null {
  if (!isApplePlatform(params.device.platform)) return null;
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
): Promise<boolean> {
  const snapshot = await captureWaitSnapshot(params);
  return Boolean(findNodeByLabel(snapshot.nodes, text));
}

async function captureWaitSnapshot(params: SelectorRuntimeDeviceParams) {
  const captureRuntime = createSelectorCaptureRuntime({
    device: params.device,
    session: params.session,
    sessionStore: params.sessionStore,
    sessionName: params.sessionName,
    req: params.req,
    logPath: params.logPath,
  });
  const { snapshot } = await captureRuntime.capture({
    flags: {
      ...params.req.flags,
      snapshotInteractiveOnly: false,
    },
    cache: {
      forceFresh: true,
      bypassForPostGestureStabilization: true,
    },
  });
  return snapshot;
}
