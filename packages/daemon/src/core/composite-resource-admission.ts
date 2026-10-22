import { getRequestExecutionDeadlineMs } from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import { resolveCommandCompositeResourceTrait } from '@agent-device/command-registry/registry';
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
import { refuseBoundedCompositeResourceOperation } from './lease-context.ts';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionState } from './session-state.ts';

/** Runs under the existing session/device locks before lease cleanup, admission, or health writes. */
export async function admitBoundedCompositeResourceRequest(params: {
  req: DaemonRequest;
  session: SessionState | undefined;
}): Promise<void> {
  const { req, session } = params;
  if (getRequestExecutionDeadlineMs(req.meta?.requestId) === undefined) return;
  const trait = resolveCommandCompositeResourceTrait(req.command);
  switch (trait) {
    case 'none':
      return;
    case 'session-lifecycle':
      return;
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
