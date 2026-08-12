import {
  snapshotCaptureAnnotationsFrom,
  summarizeSnapshotDiagnostics,
  type SnapshotDiffSummary,
} from '@agent-device/contracts/capture';
import { stripAndroidSystemChromeProvenance } from '@agent-device/contracts/platform';
import { isIosFamily, publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceBackend, BackendSnapshotResult } from '../backend.ts';
import type { CommandSessionRecord } from '../runtime.ts';
import { createAgentDevice } from '../runtime.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { maybeBuildAndroidSnapshotTimeoutFailure } from './android-snapshot-timeout-evidence.ts';
import { errorResponse, requireCommandSupported } from './handlers/response.ts';
import { buildIosOpenCommandHint } from './ios-app-session-hint.ts';
import { captureSnapshot, resolveSnapshotScope } from './handlers/snapshot-capture.ts';
import {
  buildSnapshotSession,
  resolveSessionDevice,
  withSessionlessRunnerCleanup,
} from './handlers/snapshot-session.ts';
import { isIosSimulator } from './device-targets.ts';
import { activateCompleteRefFrame } from './ref-frame.ts';
import {
  applyRecoveredWarningLatch,
  type CapturedSnapshotQuality,
} from './snapshot-quality-latch.ts';
import { createDaemonRuntimePolicy } from './runtime-policy.ts';
import { captureSparseFallbackScreenshot } from './sparse-fallback-screenshot.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';
import { getRequestSignal } from '../request/cancel.ts';
import { isInteractiveObservation } from './session-action-recorder.ts';
import { setSnapshotLineage } from './session-snapshot.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData, SessionState } from './types.ts';

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
        customActions: req.flags?.snapshotCustomActions,
        forceFull: req.flags?.snapshotForceFull,
      });
      const session = params.sessionStore.get(sessionName);
      const refsGeneration = publishedSnapshotGeneration(req, session);
      // ADR 0014: retain provenance in the immutable operational/ref-frame tree;
      // project only the published copy so settle and replay keep the full evidence.
      const publicNodes = stripAndroidSystemChromeProvenance(result.nodes);
      const publicResult =
        publicNodes === result.nodes ? result : { ...result, nodes: publicNodes };
      const fallbackScreenshot = await captureSparseFallbackScreenshot({
        req,
        session,
        sessionName,
        logPath: params.logPath,
        verdict: result.snapshotQuality,
      });
      const published = fallbackScreenshot
        ? {
            ...publicResult,
            fallbackScreenshotPath: fallbackScreenshot.path,
            artifacts: [fallbackScreenshot.artifact],
          }
        : publicResult;
      return {
        data: refsGeneration === undefined ? published : { ...published, refsGeneration },
        record: {
          kind: 'snapshot',
          nodes: result.nodes.length,
          truncated: result.truncated,
        },
      };
    },
  });
}

function publishedSnapshotGeneration(
  req: DaemonRequest,
  session: SessionState | undefined,
): number | undefined {
  return req.internal?.observationOnly === true ? undefined : session?.snapshotGeneration;
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
  // Pure flags+device, so it answers before the session precondition: otherwise
  // --actions on an iOS physical device costs a round trip ("run open first")
  // before reporting that the flag is unserviceable there at all.
  const customActionsGuard = requireCustomActionsSupported(req, device);
  if (customActionsGuard) return customActionsGuard;
  const iosAppSessionGuard = await requireIosAppSessionForSnapshot(params.command, session, device);
  if (iosAppSessionGuard) return iosAppSessionGuard;

  return await withSessionlessRunnerCleanup(session, device, async () => {
    const capturedQuality: CapturedSnapshotQuality = {};
    const runtime = createSnapshotRuntime({
      req,
      sessionName,
      logPath,
      sessionStore,
      session,
      device,
      snapshotScope: resolvedScope.scope,
      capturedQuality,
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
      data: applyRecoveredWarningLatch({
        session: sessionStore.get(sessionName),
        data: result.data,
        verdict: capturedQuality.value,
        internalObservation: req.internal?.observationOnly === true,
      }),
    };
  });
}

/**
 * Custom actions come from the private-AX snapshot backend, which only exists
 * on the iOS simulator. Every other target would accept the flag, take a normal
 * capture, and return nodes with no `actions` — indistinguishable from "this
 * screen has no custom actions". Refuse instead, naming the resolved target so
 * the caller knows which half of the request was impossible.
 */
function requireCustomActionsSupported(
  req: DaemonRequest,
  device: DeviceInfo,
): DaemonResponse | null {
  if (req.flags?.snapshotCustomActions !== true || isIosSimulator(device)) {
    return null;
  }
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `--actions requires an iOS simulator: custom actions are read through the private accessibility snapshot backend, which ${device.platform}/${device.kind} targets do not have.`,
    {
      hint: 'Re-run without --actions, or target an iOS simulator.',
    },
  );
}

/**
 * The guard exists for the LOCAL Apple path: an iOS capture rides the XCUITest
 * runner, which must attach to a target app, so a session with no app is a
 * capture that cannot succeed. A provider-backed (cloud) device captures
 * through the provider's own driver session instead — the page source needs no
 * app identity, which is why every other command on that path works without
 * one. Refusing there turned a healthy live session into an instant
 * SESSION_NOT_FOUND with no device round trip at all (#1658).
 *
 * The provider check belongs in this early return rather than in the hint
 * below: buildIosOpenCommandHint probes simctl, which can only ever see local
 * simulators, so running it for a hosted device is a guaranteed-useless spawn.
 */
async function requireIosAppSessionForSnapshot(
  command: 'snapshot' | 'diff',
  session: SessionState | undefined,
  device: SessionState['device'],
): Promise<DaemonResponse | null> {
  if (!isIosFamily(device) || session?.appBundleId || isActiveProviderDevice(device)) {
    return null;
  }
  // An unambiguous environment (one booted simulator, one foreground app)
  // gets the exact `open` command instead of the generic "run open first"
  // nudge — cheap, error-path only, never guesses.
  const openCommandHint = await buildIosOpenCommandHint(device);
  return errorResponse(
    'SESSION_NOT_FOUND',
    `iOS ${command} requires an active app session on the target device. Run open first (for example: open --session ${session?.name ?? 'sim'} --platform ios --device "<name>" <app>).`,
    {
      reason: 'ios_app_session_required',
      ...(openCommandHint ? { hint: openCommandHint } : {}),
    },
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
  capturedQuality: CapturedSnapshotQuality;
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
            // Only the snapshot command's response carries every stored node's
            // ref back to the client; diff returns a summary, so its refreshed
            // tree leaves client refs stale (#1076).
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

// ADR 0014: only a snapshot command hands the client the complete ref namespace,
// so only it re-authorizes a complete frame (recovering usability after a
// side-effect expiry). A diff (summary response) or a kept tree preserves the
// prior authorization state buildSnapshotSession carried over; partial
// publications (find/settled/divergence) never reach this path.
function reactivateCompleteFrameIfIssuing(
  session: SessionState,
  keepCurrentSnapshot: boolean,
  issuesRefsToClient: boolean,
): void {
  if (!keepCurrentSnapshot && issuesRefsToClient) {
    activateCompleteRefFrame(session);
  }
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
      });
      const annotations = snapshotCaptureAnnotationsFrom(capture);
      // Feed the latch seam the capture's own verdict: the stored session
      // snapshot is not a substitute (an empty ref-scoped capture retains the
      // previous snapshot, and diff never publishes the verdict).
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
    // #1271 stage 2: `snapshot` is observation-only and subject to the
    // repair-segment default exclusion; `diff` reaches this same recorder and
    // is deliberately NOT in the classifier's command set, so it is
    // unaffected. An authored `snapshot` plan step carries replay provenance
    // and stays in the heal.
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
