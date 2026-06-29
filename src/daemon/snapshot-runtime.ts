import type { AgentDeviceBackend, BackendSnapshotResult } from '../backend.ts';
import type { CommandSessionRecord } from '../runtime.ts';
import { createAgentDevice } from '../runtime.ts';
import { AppError } from '../kernel/errors.ts';
import type { SnapshotDiffSummary } from '../utils/snapshot-diff.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData, SessionState } from './types.ts';
import { SessionStore } from './session-store.ts';
import { errorResponse, requireCommandSupported } from './handlers/response.ts';
import { captureSnapshot, resolveSnapshotScope } from './handlers/snapshot-capture.ts';
import { snapshotCaptureAnnotationsFrom } from '../snapshot-capture-annotations.ts';
import {
  buildSnapshotSession,
  resolveSessionDevice,
  withSessionlessRunnerCleanup,
} from './handlers/snapshot-session.ts';
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { maybeBuildAndroidSnapshotTimeoutFailure } from './android-snapshot-timeout-evidence.ts';
import { summarizeSnapshotDiagnostics } from '../snapshot-diagnostics.ts';

export async function dispatchSnapshotViaRuntime(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  return await dispatchSnapshotRuntimeCommand({
    ...params,
    command: 'snapshot',
    unsupportedMessage: 'snapshot is not supported on this device',
    execute: async ({ runtime, sessionName, req, snapshotScope }) => {
      const result = await runtime.capture.snapshot({
        session: sessionName,
        interactiveOnly: req.flags?.snapshotInteractiveOnly,
        depth: req.flags?.snapshotDepth,
        scope: snapshotScope,
        raw: req.flags?.snapshotRaw,
        forceFull: req.flags?.snapshotForceFull,
      });
      return {
        data: result,
        record: {
          kind: 'snapshot',
          nodes: result.nodes.length,
          truncated: result.truncated,
        },
      };
    },
  });
}

export async function dispatchSnapshotDiffViaRuntime(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  return await dispatchSnapshotRuntimeCommand({
    ...params,
    command: 'diff',
    unsupportedMessage: 'diff is not supported on this device',
    execute: async ({ runtime, sessionName, req, snapshotScope }) => {
      const result = await runtime.capture.diffSnapshot({
        session: sessionName,
        interactiveOnly: req.flags?.snapshotInteractiveOnly,
        depth: req.flags?.snapshotDepth,
        scope: snapshotScope,
        raw: req.flags?.snapshotRaw,
      });
      return {
        data: result,
        record: {
          kind: 'diff',
          mode: 'snapshot',
          baselineInitialized: result.baselineInitialized,
          summary: result.summary,
        },
      };
    },
  });
}

type SnapshotRuntimeCommandParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  command: 'snapshot' | 'diff';
  unsupportedMessage: string;
  execute(params: {
    runtime: ReturnType<typeof createSnapshotRuntime>;
    sessionName: string;
    req: DaemonRequest;
    snapshotScope: string | undefined;
  }): Promise<{ data: DaemonResponseData; record: SnapshotRuntimeRecord }>;
};

type SnapshotRuntimeRecord =
  | { kind: 'snapshot'; nodes: number; truncated: boolean | undefined }
  | {
      kind: 'diff';
      mode: 'snapshot';
      baselineInitialized: boolean;
      summary: SnapshotDiffSummary;
    };

async function dispatchSnapshotRuntimeCommand(
  params: SnapshotRuntimeCommandParams,
): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;
  const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
  const unsupported = requireCommandSupported(params.command, device, {
    message: params.unsupportedMessage,
  });
  if (unsupported) return unsupported;
  const resolvedScope = resolveSnapshotScope(req.flags?.snapshotScope, session);
  if (!resolvedScope.ok) return resolvedScope;
  const iosAppSessionGuard = requireIosAppSessionForSnapshot(params.command, session, device);
  if (iosAppSessionGuard) return iosAppSessionGuard;

  return await withSessionlessRunnerCleanup(session, device, async () => {
    const runtime = createSnapshotRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      session,
      device,
      snapshotScope: resolvedScope.scope,
    });
    let result: Awaited<ReturnType<SnapshotRuntimeCommandParams['execute']>>;
    try {
      result = await params.execute({
        runtime,
        sessionName,
        req,
        snapshotScope: resolvedScope.scope,
      });
    } catch (error) {
      const timeoutResponse = await maybeBuildAndroidSnapshotTimeoutFailure({
        error,
        command: params.command,
        logPath,
        session,
        device,
      });
      if (!timeoutResponse) throw error;
      return timeoutResponse;
    }
    recordSnapshotRuntimeAction({
      req,
      sessionName,
      sessionStore,
      result: result.record,
    });
    return {
      ok: true,
      data: result.data,
    };
  });
}

function requireIosAppSessionForSnapshot(
  command: 'snapshot' | 'diff',
  session: SessionState | undefined,
  device: SessionState['device'],
): DaemonResponse | null {
  if (device.platform !== 'ios' || session?.appBundleId) {
    return null;
  }
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS ${command} requires an active app session on the target device. Run open first (for example: open --session ${session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
  );
}

function createSnapshotRuntime(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
  snapshotScope: string | undefined;
}) {
  const { req, sessionName, logPath, sessionStore, session, device, snapshotScope } = params;
  return createAgentDevice({
    backend: createDaemonSnapshotBackend({
      req,
      logPath,
      session,
      device,
      snapshotScope,
    }),
    ...createDaemonRuntimePolicy('snapshot'),
    sessions: createDaemonRuntimeSessionStore({
      sessionName,
      getSession: () => sessionStore.get(sessionName),
      recordOptions: { includeSnapshot: true },
      setRecord: (record) => {
        const snapshotRecord = assertSnapshotSessionRecord(record);
        const current = sessionStore.get(sessionName);
        sessionStore.set(
          sessionName,
          buildNextSnapshotSession({
            current,
            sessionName,
            device,
            record: snapshotRecord,
            refScopedSnapshot: isRefScopedSnapshot(req),
          }),
        );
      },
    }),
  });
}

function buildNextSnapshotSession(params: {
  current: SessionState | undefined;
  sessionName: string;
  device: SessionState['device'];
  record: CommandSessionRecord & { snapshot: NonNullable<CommandSessionRecord['snapshot']> };
  refScopedSnapshot: boolean;
}): SessionState {
  const { current, sessionName, device, record, refScopedSnapshot } = params;
  const keepCurrentSnapshot = shouldKeepCurrentSnapshot(current, record, refScopedSnapshot);
  const snapshot = keepCurrentSnapshot ? current.snapshot : record.snapshot;
  const nextSession = buildSnapshotSession({
    session: current,
    sessionName,
    device,
    snapshot,
    appBundleId: record.appBundleId,
  });
  nextSession.snapshotScopeSource = resolveNextSnapshotScopeSource({
    current,
    keepCurrentSnapshot,
    refScopedSnapshot,
  });
  if (record.appName) nextSession.appName = record.appName;
  return nextSession;
}

function isRefScopedSnapshot(req: DaemonRequest): boolean {
  return req.flags?.snapshotScope?.trim().startsWith('@') === true;
}

function shouldKeepCurrentSnapshot(
  current: SessionState | undefined,
  record: CommandSessionRecord,
  refScopedSnapshot: boolean,
): current is SessionState & { snapshot: NonNullable<SessionState['snapshot']> } {
  return (
    refScopedSnapshot && record.snapshot?.nodes.length === 0 && current?.snapshot !== undefined
  );
}

function resolveNextSnapshotScopeSource(params: {
  current: SessionState | undefined;
  keepCurrentSnapshot: boolean;
  refScopedSnapshot: boolean;
}): SessionState['snapshotScopeSource'] {
  const { current, keepCurrentSnapshot, refScopedSnapshot } = params;
  if (!refScopedSnapshot) return undefined;
  if (keepCurrentSnapshot) return current?.snapshotScopeSource;
  return current?.snapshotScopeSource ?? current?.snapshot;
}

function createDaemonSnapshotBackend(params: {
  req: DaemonRequest;
  logPath: string;
  session: SessionState | undefined;
  device: SessionState['device'];
  snapshotScope: string | undefined;
}): AgentDeviceBackend {
  const { req, logPath, session, device, snapshotScope } = params;
  return {
    platform: device.platform,
    captureSnapshot: async (_context, options): Promise<BackendSnapshotResult> => {
      const capture = await captureSnapshot({
        device,
        session,
        flags: req.flags,
        outPath: options?.outPath ?? req.flags?.out,
        logPath,
        snapshotScope,
      });
      const snapshotDiagnostics = summarizeSnapshotDiagnostics(session);
      return {
        snapshot: capture.snapshot,
        ...snapshotCaptureAnnotationsFrom(capture),
        ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
        appName: session?.appBundleId ? (session.appName ?? session.appBundleId) : undefined,
        appBundleId: session?.appBundleId,
      };
    },
  };
}

function recordSnapshotRuntimeAction(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  result: SnapshotRuntimeRecord;
}): void {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return;
  params.sessionStore.recordAction(session, {
    command: params.req.command,
    positionals: params.req.positionals ?? [],
    flags: params.req.flags ?? {},
    result: toRecordedSnapshotRuntimeResult(params.result),
  });
}

function assertSnapshotSessionRecord(
  record: CommandSessionRecord,
): CommandSessionRecord & { snapshot: NonNullable<CommandSessionRecord['snapshot']> } {
  if (!record.snapshot) {
    throw new AppError('UNKNOWN', 'snapshot runtime did not produce session state');
  }
  return record as CommandSessionRecord & {
    snapshot: NonNullable<CommandSessionRecord['snapshot']>;
  };
}

function toRecordedSnapshotRuntimeResult(record: SnapshotRuntimeRecord): Record<string, unknown> {
  if (record.kind === 'snapshot') {
    return { nodes: record.nodes, truncated: record.truncated };
  }
  return {
    mode: record.mode,
    baselineInitialized: record.baselineInitialized,
    summary: record.summary,
  };
}
