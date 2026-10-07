import {
  copySnapshotClickabilityEvidence,
  snapshotCaptureAnnotationsFrom,
  summarizeSnapshotDiagnostics,
  type SnapshotDiffSummary,
} from '@agent-device/contracts/capture';
import type { SnapshotResult } from '@agent-device/contracts/snapshot-runtime';
import { publicPlatformString } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceBackend, BackendSnapshotResult } from '../backend.ts';
import type { CommandSessionRecord } from '../runtime-contract.ts';
import { createCommandSurfaceAgentDevice } from '../runtime-command-surface.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { maybeBuildAndroidSnapshotTimeoutFailure } from './android-snapshot-timeout-evidence.ts';
import { captureSnapshot } from './snapshot-capture.ts';
import { createSnapshotSession, withSessionlessRunnerCleanup } from './snapshot-session.ts';
import { resolveSessionScope } from './session-routing.ts';
import { activateCompleteRefFrame } from './ref-frame.ts';
import {
  applyRecoveredWarningLatch,
  type CapturedSnapshotQuality,
} from './snapshot-quality-latch.ts';
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { isInteractiveObservation } from './session-action-recorder.ts';
import { setCommandSnapshot } from './session-snapshot.ts';
import { SessionStore } from './session-store.ts';
import {
  resolveBoundSnapshotCaptureRuntime,
  type SnapshotRuntimeRouteParams,
} from './snapshot-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData } from './daemon-request.ts';
import type { SessionRef, SessionState } from './session-state.ts';

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
    runtime: ReturnType<typeof createSnapshotRuntime>['runtime'];
    sessionName: string;
    req: DaemonRequest;
    snapshotScope: string | undefined;
    getSession(): SessionState | undefined;
  }): Promise<{ data: DaemonResponseData; record: SnapshotRuntimeRecord }>;
};

/** Shared snapshot/diff command construction after one request-bound capture has been admitted. */
export async function dispatchSnapshotRuntimeCommand(
  params: SnapshotRuntimeCommandParams,
): Promise<DaemonResponse> {
  const capture = await resolveBoundSnapshotCaptureRuntime(params, params.command);
  if (!capture.ok) return capture.response;
  const { ref, session, device, snapshotScope } = capture;
  return await withSessionlessRunnerCleanup(
    session,
    device,
    async () => {
      const { req, logPath, sessionStore } = params;
      const sessionName = ref?.address ?? params.sessionName;
      const capturedQuality: CapturedSnapshotQuality = {};
      const { runtime, sessions } = createSnapshotRuntime({
        req,
        sessionName,
        logPath,
        sessionStore,
        ref,
        session,
        device,
        snapshotScope,
        capturedQuality,
        captureSnapshotData: capture.captureSnapshot,
      });
      const getSession = () => {
        const currentRef = sessions.getRef();
        return currentRef ? sessionStore.requireCurrent(currentRef) : undefined;
      };
      let result: Awaited<ReturnType<SnapshotRuntimeCommandParams['execute']>>;
      try {
        result = await params.execute({ runtime, sessionName, req, snapshotScope, getSession });
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
      const current = getSession();
      recordSnapshotRuntimeAction({
        req,
        sessionName,
        sessionStore,
        ref: sessions.getRef(),
        result: result.record,
      });
      const data = applyRecoveredWarningLatch({
        session: current,
        data: result.data,
        verdict: capturedQuality.value,
        internalObservation: req.internal?.observationOnly === true,
      });
      return {
        ok: true,
        data: copySnapshotClickabilityEvidence(result.data, data),
      };
    },
    params.platformResourceCleanup,
  );
}

function createSnapshotRuntime(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  ref: SessionRef | undefined;
  session: SessionState | undefined;
  device: SessionState['device'];
  snapshotScope: string | undefined;
  capturedQuality: CapturedSnapshotQuality;
  captureSnapshotData: () => Promise<SnapshotResult>;
}) {
  const { req, sessionName, logPath, sessionStore, session, device, snapshotScope } = params;
  const sessions = createDaemonRuntimeSessionStore({
    sessionName,
    sessionStore,
    ref: params.ref,
    recordOptions: { includeSnapshot: true },
    setRecord: (record, current, ref) => {
      const snapshotRecord = assertSnapshotSessionRecord(record);
      const keepCurrentSnapshot = shouldKeepCurrentSnapshot(
        current,
        snapshotRecord,
        isRefScopedSnapshot(req),
      );
      const snapshot = keepCurrentSnapshot ? current.snapshot : snapshotRecord.snapshot;
      const nextSession: SessionState = ref
        ? sessionStore.update(ref, {})
        : createSnapshotSession({
            sessionName,
            sessionScope: resolveSessionScope(req),
            device,
            snapshot,
            appBundleId: record.appBundleId,
          });
      nextSession.appName = record.appName ?? current?.appName;
      setCommandSnapshot(nextSession, {
        snapshot,
        scopeSource: resolveNextSnapshotScopeSource({
          current,
          keepCurrentSnapshot,
          refScopedSnapshot: isRefScopedSnapshot(req),
        }),
        keptCurrentSnapshot: keepCurrentSnapshot,
        previousGeneration: current?.snapshotGeneration,
      });
      reactivateCompleteFrameIfIssuing(
        nextSession,
        keepCurrentSnapshot,
        req.command === 'snapshot' && req.internal?.observationOnly !== true,
      );
      return ref ?? sessionStore.publish(sessionName, nextSession);
    },
  });
  const runtime = createCommandSurfaceAgentDevice({
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
    sessions,
  });
  return { runtime, sessions };
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
    captureSnapshot: async (context): Promise<BackendSnapshotResult> => {
      const capture = await captureSnapshot({
        device,
        session,
        flags: req.flags,
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
  ref: SessionRef | undefined;
  result: SnapshotRuntimeRecord;
}): void {
  if (!params.ref) return;
  params.sessionStore.recordAction(params.ref, {
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
