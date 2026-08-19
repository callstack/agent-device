import {
  snapshotCaptureAnnotationsFrom,
  summarizeSnapshotDiagnostics,
  type SnapshotDiffSummary,
} from '@agent-device/contracts/capture';
import type { SnapshotResult } from '@agent-device/contracts/platform';
import { publicPlatformString } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceBackend, BackendSnapshotResult } from '../backend.ts';
import type { CommandSessionRecord } from '../runtime.ts';
import { createAgentDevice } from '../runtime.ts';
import { getRequestSignal } from '../request/cancel.ts';
import { maybeBuildAndroidSnapshotTimeoutFailure } from './android-snapshot-timeout-evidence.ts';
import { captureSnapshot } from './handlers/snapshot-capture.ts';
import { buildSnapshotSession, withSessionlessRunnerCleanup } from './handlers/snapshot-session.ts';
import { activateCompleteRefFrame } from './ref-frame.ts';
import {
  applyRecoveredWarningLatch,
  type CapturedSnapshotQuality,
} from './snapshot-quality-latch.ts';
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { isInteractiveObservation } from './session-action-recorder.ts';
import { setSnapshotLineage } from './session-snapshot.ts';
import { SessionStore } from './session-store.ts';
import {
  resolveBoundSnapshotCaptureRuntime,
  type SnapshotRuntimeRouteParams,
} from './snapshot-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData, SessionState } from './types.ts';

export type SnapshotRuntimeRecord =
  | { kind: 'snapshot'; nodes: number; truncated: boolean | undefined }
  | {
      kind: 'diff';
      mode: 'snapshot';
      baselineInitialized: boolean;
      summary: SnapshotDiffSummary;
    };

type SnapshotRuntimeCommandParams = SnapshotRuntimeRouteParams & {
  command: 'snapshot' | 'diff';
  execute(params: {
    runtime: ReturnType<typeof createSnapshotRuntime>;
    sessionName: string;
    req: DaemonRequest;
    snapshotScope: string | undefined;
  }): Promise<{ data: DaemonResponseData; record: SnapshotRuntimeRecord }>;
};

/** Shared snapshot/diff command construction after one request-bound capture has been admitted. */
export async function dispatchSnapshotRuntimeCommand(
  params: SnapshotRuntimeCommandParams,
): Promise<DaemonResponse> {
  const capture = await resolveBoundSnapshotCaptureRuntime(params, params.command);
  if (!capture.ok) return capture.response;
  const { session, device, snapshotScope } = capture;
  return await withSessionlessRunnerCleanup(session, device, async () => {
    const { req, sessionName, logPath, sessionStore } = params;
    const capturedQuality: CapturedSnapshotQuality = {};
    const runtime = createSnapshotRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      session,
      device,
      snapshotScope,
      capturedQuality,
      captureSnapshotData: capture.captureSnapshot,
    });
    let result: Awaited<ReturnType<SnapshotRuntimeCommandParams['execute']>>;
    try {
      result = await params.execute({ runtime, sessionName, req, snapshotScope });
    } catch (error) {
      const timeoutResponse = await maybeBuildAndroidSnapshotTimeoutFailure({
        error,
        command: params.command,
        logPath,
        session,
        device,
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
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
      data: applyRecoveredWarningLatch({
        session: sessionStore.get(sessionName),
        data: result.data,
        verdict: capturedQuality.value,
        internalObservation: req.internal?.observationOnly === true,
      }),
    };
  });
}

function createSnapshotRuntime(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  session: SessionState | undefined;
  device: SessionState['device'];
  snapshotScope: string | undefined;
  capturedQuality: CapturedSnapshotQuality;
  captureSnapshotData: () => Promise<SnapshotResult>;
}) {
  const { req, sessionName, logPath, sessionStore, session, device, snapshotScope } = params;
  return createAgentDevice({
    backend: createDaemonSnapshotBackend({
      req,
      logPath,
      session,
      device,
      snapshotScope,
      capturedQuality: params.capturedQuality,
      captureSnapshotData: params.captureSnapshotData,
    }),
    ...createDaemonRuntimePolicy('snapshot'),
    signal: getRequestSignal(req.meta?.requestId),
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
            // Only snapshot publishes the complete stored tree. A diff refreshes the
            // observation but leaves the client's existing ref authorization unchanged.
            issuesRefsToClient:
              req.command === 'snapshot' && req.internal?.observationOnly !== true,
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
  issuesRefsToClient: boolean;
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
  setSnapshotLineage(nextSession, {
    scopeSource: resolveNextSnapshotScopeSource({
      current,
      keepCurrentSnapshot,
      refScopedSnapshot,
    }),
    keptCurrentSnapshot: keepCurrentSnapshot,
    previousGeneration: current?.snapshotGeneration,
  });
  reactivateCompleteFrameIfIssuing(nextSession, keepCurrentSnapshot, params.issuesRefsToClient);
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

// ADR 0014: only a snapshot command hands the client the complete ref namespace.
function reactivateCompleteFrameIfIssuing(
  session: SessionState,
  keepCurrentSnapshot: boolean,
  issuesRefsToClient: boolean,
): void {
  if (!keepCurrentSnapshot && issuesRefsToClient) activateCompleteRefFrame(session);
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
  capturedQuality: CapturedSnapshotQuality;
  captureSnapshotData: () => Promise<SnapshotResult>;
}): AgentDeviceBackend {
  const { req, logPath, session, device, snapshotScope } = params;
  return {
    platform: publicPlatformString(device),
    captureSnapshot: async (context, options): Promise<BackendSnapshotResult> => {
      const capture = await captureSnapshot({
        device,
        session,
        flags: req.flags,
        outPath: options?.outPath ?? req.flags?.out,
        logPath,
        snapshotScope,
        signal: context.signal,
        captureData: params.captureSnapshotData,
      });
      const annotations = snapshotCaptureAnnotationsFrom(capture);
      params.capturedQuality.value = annotations.quality;
      const snapshotDiagnostics = summarizeSnapshotDiagnostics(session);
      return {
        snapshot: capture.snapshot,
        ...annotations,
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
    interactiveObservation: isInteractiveObservation(params.req),
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
