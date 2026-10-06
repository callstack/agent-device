import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  parseAudioProbeRequest,
  resolveAudioRuntimePlan,
  type AudioProbeRequest,
  type audioProbeStartUse,
} from '@agent-device/contracts/audio-runtime-plan';
import { emptyAudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { type AudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import {
  adoptStartedAudioProbe,
  audioProbeDurableResource,
  finishLiveAudioProbe,
} from '@agent-device/capture-kit/audio-probe-session-resource';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import type { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../daemon-request.ts';
import type { SessionRef } from '../../session-state.ts';
import { bindSessionAudioProbe } from '../../session-capture-binding.ts';
import { type DaemonFailureResponse, errorResponse } from '@agent-device/kernel/contracts';

type AudioParams = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  audioProbeAdmissionLedger: AudioProbeAdmissionLedger;
  throwIfCanceled(): void;
};

export async function handleAudioCommand(params: AudioParams): Promise<DaemonResponse> {
  try {
    return await handleAudioCommandUnsafe(params);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function handleAudioCommandUnsafe(params: AudioParams): Promise<DaemonResponse> {
  const sessionResult = resolveAudioSession(params);
  if (!sessionResult.ok) return sessionResult;
  const ref = sessionResult.ref;
  const session = params.sessionStore.requireCurrent(ref);
  const request = parseAudioProbeRequest(params.req.positionals);
  // Facts, not a capability bucket, decide which of the two owner paths this device has —
  // side-effect-free per ADR 0019 §9; the one bind below uses the plan's own use.
  const facts = await params.inspectFacts(session.device);
  const startFact = facts.operations.audioProbeStart;
  const queryFact = facts.operations.audioProbeQuery;
  const mode = startFact.available ? 'capture' : queryFact.available ? 'query' : undefined;
  if (mode === undefined) return audioUnsupportedResponse(startFact, queryFact);
  const plan = resolveAudioRuntimePlan({ probeAction: request.probeAction, mode });
  switch (plan.kind) {
    case 'query': {
      const runtime = await params.bindDevice(session.device, plan.use);
      return {
        ok: true,
        data: await runtime.operations.audioProbeQuery({
          action: plan.action,
          durationMs: request.durationMs,
          bucketMs: request.bucketMs,
        }),
      };
    }
    case 'capture-start':
      return await startAudioProbe(params, ref, request, plan.use);
    case 'capture-status':
      return await audioProbeStatus(params, ref);
    case 'capture-stop':
      return await stopAudioProbe(params, ref);
  }
}

function resolveAudioSession(
  params: AudioParams,
): { ok: true; ref: SessionRef } | DaemonFailureResponse {
  const ref = params.sessionStore.lookup(params.sessionName);
  if (!ref) return errorResponse('SESSION_NOT_FOUND', 'audio requires an active session');
  return { ok: true, ref };
}

function audioUnsupportedResponse(
  startFact: RuntimeOperationFact,
  queryFact: RuntimeOperationFact,
): DaemonFailureResponse {
  const hint =
    (!startFact.available ? startFact.hint : undefined) ??
    (!queryFact.available ? queryFact.hint : undefined);
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    hint ??
      'audio is supported for web browser sessions, macOS sessions, iOS simulators, and Android emulators on macOS hosts',
  );
}

async function startAudioProbe(
  params: AudioParams,
  ref: SessionRef,
  request: AudioProbeRequest,
  use: typeof audioProbeStartUse,
): Promise<DaemonResponse> {
  let session = params.sessionStore.requireCurrent(ref);
  const binding = bindSessionAudioProbe(params.sessionStore, ref);
  // Start restarts an already-running probe (legacy parity), completing it through the durable
  // coordinator so the previous envelope terminalizes before a new fence is minted. Nobody reads
  // that completion, so the previous probe is being handed back rather than captured.
  if (session.audioProbe) {
    await finishLiveAudioProbe({
      intent: 'disposal',
      binding,
    });
    session = params.sessionStore.requireCurrent(ref);
  }
  const runtime = await params.bindDevice(session.device, use);
  const resourcePath = audioProbeDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  const fence = audioProbeDurableResource.createNextFence({
    admissionLedger: params.audioProbeAdmissionLedger,
    resourcePath,
    device: session.device,
  });
  const statusPath = path.join(
    params.sessionStore.ensureSessionDir(params.sessionName),
    'audio-probe.json',
  );
  binding.assertAdoptable();
  const started = await runtime.operations.audioProbeStart({
    sessionId: params.sessionName,
    statusPath,
    durationMs: request.durationMs,
    bucketMs: request.bucketMs,
    fence,
  });
  await adoptStartedAudioProbe({
    admissionLedger: params.audioProbeAdmissionLedger,
    binding,
    device: session.device,
    owner: runtime.owner,
    fence,
    ...started,
    throwIfCanceled: params.throwIfCanceled,
  });
  const adopted = binding.read();
  if (!adopted) throw new TypeError('Audio probe adoption did not publish a live handle');
  return { ok: true, data: await adopted.handle.status() };
}

async function audioProbeStatus(params: AudioParams, ref: SessionRef): Promise<DaemonResponse> {
  const binding = bindSessionAudioProbe(params.sessionStore, ref);
  const probe = binding.read();
  if (!probe) return { ok: true, data: inactiveAudioProbeResult() };
  const data = await probe.handle.status();
  if (data.state === 'stopped') {
    // The sampler completed on its own: finish through the coordinator so the envelope
    // terminalizes and the slot clears, but answer with the observed status. The caller asked for
    // status, never for an export no later stop could produce from a dead sampler.
    await finishLiveAudioProbe({
      intent: 'disposal',
      binding,
    });
  }
  return { ok: true, data };
}

async function stopAudioProbe(params: AudioParams, ref: SessionRef): Promise<DaemonResponse> {
  const binding = bindSessionAudioProbe(params.sessionStore, ref);
  if (!binding.read()) return { ok: true, data: inactiveAudioProbeResult() };
  const completion = await finishLiveAudioProbe({
    intent: 'capture',
    binding,
  });
  return { ok: true, data: completion };
}

function inactiveAudioProbeResult() {
  return emptyAudioProbeResult({
    state: 'stopped',
    source: 'system-audio',
    backend: 'host-system-audio',
    durationMs: 0,
    bucketMs: 0,
    sourceCount: 0,
    reason: 'not-started',
    notes: ['No active host audio probe is running.'],
  });
}
