import { AppError } from '@agent-device/kernel/errors';
import {
  resolveCommandCompositeResourceTrait,
  resolveCommandDeviceClaimPolicy,
} from '@agent-device/command-registry/registry';
import {
  parsePerfRuntimeRequest,
  resolvePerfRuntimePlan,
} from '@agent-device/capture-kit/perf-runtime-plan';
import { resolveLogsRuntimePlan } from '@agent-device/contracts/logs-runtime-plan';
import {
  parseAudioProbeRequest,
  resolveAudioRuntimePlan,
} from '@agent-device/contracts/audio-runtime-plan';
import { resolveScreenRecordingRuntimePlan } from '@agent-device/contracts/screen-recording-runtime-plan';
import { parseTraceAction, TRACE_ACTION_REQUIRED_MESSAGE } from '@agent-device/contracts/recording';
import { isActiveProviderDevice } from './provider-device-admission.ts';
import {
  isBoundedCompositeRequest,
  refuseBoundedCompositeResourceOperation,
} from './lease-context.ts';
import {
  inspectDeviceClaimAcquisition,
  type DeviceClaim,
  type InspectedDeviceClaim,
} from '@agent-device/daemon-contracts/device-claims';
import {
  inspectDeviceClaimRecovery,
  type ClaimRecoveryInspection,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionState } from './session-state.ts';

function sessionResourceKinds(session: SessionState | undefined, platformOwned: readonly string[]) {
  if (!session) return [];
  return [
    ...platformOwned,
    ...(session.screenRecording ? ['screen-recording'] : []),
    ...(session.appLog ? ['app-log'] : []),
    ...(session.audioProbe ? ['audio-probe'] : []),
    ...(session.perfCapture ? ['perf-capture'] : []),
    ...(session.trace ? ['trace-log'] : []),
  ];
}

function assertBoundedCompositeSessionDisposal(
  req: DaemonRequest,
  session: SessionState | undefined,
  platformOwned: readonly string[],
  closeWouldReleaseProviderLease: boolean,
): void {
  const resources = [
    ...sessionResourceKinds(session, platformOwned),
    ...(closeWouldReleaseProviderLease ? ['provider-lease'] : []),
  ];
  if (resources.length > 0) {
    refuseBoundedCompositeResourceOperation(
      req,
      `session-resource-disposal:${resources.join(',')}`,
    );
  }
}

/** Runs under the existing session/device locks before lease cleanup, admission, or health writes. */
export async function admitBoundedCompositeResourceRequest(params: {
  req: DaemonRequest;
  session: SessionState | undefined;
  validateSessionReopen: (session: SessionState) => Promise<void>;
  inspectSessionTeardownResources: (session: SessionState) => Promise<readonly string[]>;
  closeWouldReleaseProviderLease: () => boolean;
  claimRecovery: {
    currentSessionExists: boolean;
    resolveDevice: () => Promise<DeviceInfo>;
    session: string;
    workspace: string;
    stateDir: string;
    env: EnvMap;
    coveredClaimIsOwnedByRequest: (claim: DeviceClaim) => boolean;
    observeDeviceBoot?: DeviceBootObservationService;
    claimConflictError: (device: DeviceInfo, conflict: InspectedDeviceClaim) => AppError;
    hasInMemorySessionOwner: (device: DeviceInfo) => boolean;
  };
}): Promise<void> {
  const { req, session } = params;
  if (!isBoundedCompositeRequest(req)) return;
  const trait = resolveCommandCompositeResourceTrait(req.command);
  switch (trait) {
    case 'none':
      return await assertBoundedClaimRecovery(req, params.claimRecovery);
    case 'session-lifecycle':
      return await admitSessionLifecycleRequest(params);
    case 'nested-test':
      await admitBoundedTestRequest(req);
      return;
    case 'operation':
      admitResourceOperation(req, session);
      return;
    default:
      refuseBoundedCompositeResourceOperation(req, `${req.command}:unclassified`);
  }
}

async function admitSessionLifecycleRequest(
  params: Parameters<typeof admitBoundedCompositeResourceRequest>[0],
): Promise<void> {
  const { req, session } = params;
  // Maestro app-only close leaves the session and its durable resources owned.
  if (req.command === 'close' && req.internal?.closeAppOnly === true) return;
  if (req.command === 'open' && session) await params.validateSessionReopen(session);
  const platformOwned =
    req.command === 'close' && session ? await params.inspectSessionTeardownResources(session) : [];
  if (req.command === 'open' && sessionResourceKinds(session, platformOwned).length > 0) {
    refuseBoundedCompositeResourceOperation(req, 'session-reopen-with-resources');
  }
  if (req.command === 'close') {
    assertBoundedCompositeSessionDisposal(
      req,
      session,
      platformOwned,
      params.closeWouldReleaseProviderLease(),
    );
  }
  await assertBoundedClaimRecovery(req, params.claimRecovery);
}

async function assertBoundedClaimRecovery(
  req: DaemonRequest,
  params: Parameters<typeof admitBoundedCompositeResourceRequest>[0]['claimRecovery'],
): Promise<void> {
  const policy = resolveCommandDeviceClaimPolicy(req.command);
  if (policy !== 'acquire-session' && policy !== 'transient-exclusive') return;
  if (req.command === 'open' && params.currentSessionExists) return;
  const device = await params.resolveDevice();
  if (req.command === 'open' && params.hasInMemorySessionOwner(device)) return;
  if (isActiveProviderDevice(device)) return;
  const settlements = await inspectDeviceClaimAcquisition({
    device,
    command: req.command,
    session: params.session,
    workspace: params.workspace,
    stateDir: params.stateDir,
    env: params.env,
    coveredClaimIsOwnedByRequest: params.coveredClaimIsOwnedByRequest,
    ...(policy === 'acquire-session' ? { observeDeviceBoot: params.observeDeviceBoot } : {}),
  });
  for (const settlement of settlements) {
    if (settlement.status === 'conflict')
      throw params.claimConflictError(device, settlement.conflict);
    if (settlement.status !== 'reconcile') continue;
    const inspection = inspectBoundedClaimBeforeGateway(req, settlement.claim);
    if (inspection?.status === 'retained') {
      throw params.claimConflictError(device, settlement.conflict);
    }
  }
}

function inspectBoundedClaimBeforeGateway(
  req: DaemonRequest,
  claim: DeviceClaim,
): ClaimRecoveryInspection | undefined {
  if (req.command === 'batch' || req.command === 'replay' || !isBoundedCompositeRequest(req)) {
    return undefined;
  }
  const inspection = inspectDeviceClaimRecovery(claim);
  if (inspection.status === 'inspectable' && inspection.ownedResources.length > 0) {
    refuseBoundedCompositeResourceOperation(
      req,
      `session-resource-recovery:${inspection.ownedResources[0]!.resourceKind}`,
    );
  }
  return inspection;
}

/** The same refusal guards both routed and transient reconciliation before gateway composition. */
export function createBoundedClaimRecoveryBeforeGateway(
  req: DaemonRequest,
): (claim: DeviceClaim) => ClaimRecoveryInspection | undefined {
  return (claim: DeviceClaim) => inspectBoundedClaimBeforeGateway(req, claim);
}

function admitResourceOperation(req: DaemonRequest, session: SessionState | undefined): void {
  switch (req.command) {
    case 'perf':
      return admitPerfOperation(req);
    case 'record': {
      const plan = resolveScreenRecordingRuntimePlan({
        action: req.positionals?.[0],
        scope: req.flags?.recordingScope,
        hasLiveHandle: session?.screenRecording !== undefined,
      });
      refuseBoundedCompositeResourceOperation(req, `record:${plan.kind}`);
      return;
    }
    case 'logs':
      return admitLogsOperation(req, session);
    case 'audio':
      return admitAudioOperation(req, session);
    case 'trace':
      {
        const action = parseTraceAction(req.positionals);
        if (!action) throw new AppError('INVALID_ARGS', TRACE_ACTION_REQUIRED_MESSAGE);
        refuseBoundedCompositeResourceOperation(req, `trace:${action}`);
      }
      return;
    default:
      refuseBoundedCompositeResourceOperation(req, `${req.command}:unclassified-operation`);
  }
}

function admitPerfOperation(req: DaemonRequest): void {
  const request = parsePerfRuntimeRequest({
    positionals: req.positionals,
    kind: req.flags?.kind,
    outPath: req.flags?.out,
  });
  const plan = resolvePerfRuntimePlan(request);
  refuseBoundedCompositeResourceOperation(req, `perf:${plan.kind}`);
}

function admitLogsOperation(req: DaemonRequest, session: SessionState | undefined): void {
  const plan = resolveLogsRuntimePlan({
    action: req.positionals?.[0],
    restart: req.flags?.restart,
    marker: req.positionals?.slice(1).join(' '),
  });
  if (['start', 'stop', 'clear-restart'].includes(plan.kind)) {
    refuseBoundedCompositeResourceOperation(req, `logs:${plan.kind}`);
    return;
  }
  if (session && !isActiveProviderDevice(session.device)) {
    if (session.device.platform === 'android') {
      refuseBoundedCompositeResourceOperation(req, `logs:${plan.kind}`);
    }
    return;
  }
  refuseBoundedCompositeResourceOperation(req, `logs:${plan.kind}:unverified-owner`);
}

function admitAudioOperation(req: DaemonRequest, session: SessionState | undefined): void {
  const request = parseAudioProbeRequest(req.positionals);
  if (!session || isActiveProviderDevice(session.device)) {
    refuseBoundedCompositeResourceOperation(req, 'audio:unverified-owner');
    return;
  }
  const mode = session.device.platform === 'web' ? 'query' : 'capture';
  const plan = resolveAudioRuntimePlan({ probeAction: request.probeAction, mode });
  refuseBoundedCompositeResourceOperation(req, `audio:${plan.kind}`);
}

async function admitBoundedTestRequest(req: DaemonRequest): Promise<void> {
  if (req.flags?.timeoutMs !== undefined) {
    refuseBoundedCompositeResourceOperation(req, 'test:attempt-timeout');
  }
  if (req.flags?.recordVideo === true) {
    refuseBoundedCompositeResourceOperation(req, 'test:record-video');
  }
  const sources = req.flags?.replayScriptSources;
  if (sources === undefined) return;
  const { buildReplayTestSourceDiscovery } =
    await import('@agent-device/replay-port/session-test-source-discovery');
  const discoverSources = await buildReplayTestSourceDiscovery(sources, req.flags?.replayBackend);
  if (
    discoverSources().some((source) => source.manifest.attemptDefaults?.timeoutMs !== undefined)
  ) {
    refuseBoundedCompositeResourceOperation(req, 'test:attempt-timeout');
  }
}
