import { getRequestSignal, throwIfRequestCanceled } from '@agent-device/host-kit/request';
import { errorResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import { handleRecordCommand } from './record-runtime.ts';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
} from '../../core/request-runtime-binding.ts';
import { type ScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { SessionRef } from '../../core/session-state.ts';
import { type WithSessionExecutionLock, type SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { ReplayTestVideoOwner } from '@agent-device/replay-port/command-types';

type ReplayRecordVideoRequest = Parameters<ReplayTestVideoOwner['record']>[0];

export type ReplayTestVideoOwnerParams = Readonly<{
  sessionStore: SessionStore;
  sessionRef: (name: string, phase: ReplayRecordVideoRequest['phase']) => SessionRef | undefined;
  withSessionExecutionLock: WithSessionExecutionLock;
  bindDevice?: BindDeviceRuntime;
  platformServices: DaemonPlatformServices;
  bindExactDevice?: BindExactDeviceRuntime;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  requestScope?: PlatformRequestScope;
  throwIfCanceled?: () => void;
  suiteRequest?: DaemonRequest;
}>;

export function createReplayTestVideoOwner(
  params: ReplayTestVideoOwnerParams,
): ReplayTestVideoOwner | undefined {
  const {
    sessionStore,
    sessionRef,
    withSessionExecutionLock,
    bindDevice,
    platformServices,
    bindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    throwIfCanceled,
  } = params;
  if (
    !bindDevice ||
    !bindExactDevice ||
    !screenRecordingAdmissionLedger ||
    !requestScope ||
    !throwIfCanceled
  ) {
    return undefined;
  }
  const record: ReplayTestVideoOwner['record'] = async (request) => {
    if (request.phase === 'stop' && !sessionRef(request.sessionName, 'stop'))
      return { ok: true, data: {} };
    const requestId = request.request.meta?.requestId;
    const signal = request.phase === 'start' ? getRequestSignal(requestId) : undefined;
    const scope = signal ? { ...requestScope, signal } : requestScope;
    const bindStart: BindDeviceRuntime = signal
      ? (device, use) => bindDevice(device, use, 'bypass', scope)
      : bindDevice;
    return await withSessionExecutionLock(
      request.sessionName,
      async (holdDevice) => {
        signal?.throwIfAborted();
        const ref = sessionRef(request.sessionName, request.phase);
        if (!ref)
          return request.phase === 'stop'
            ? { ok: true, data: {} }
            : errorResponse(
                'NO_ACTIVE_SESSION',
                'Replay recording requires a live attempt session.',
              );
        await holdDevice(ref.session.device.id);
        return await handleRecordCommand({
          req: recordRequest(request, params.suiteRequest),
          suiteCapture:
            params.suiteRequest?.internal?.publicNetworkOnly ||
            params.suiteRequest?.meta?.clientArtifactPaths?.artifactsDir
              ? 'remote'
              : 'local',
          sessionName: ref.address,
          sessionRef: ref,
          sessionStore,
          bindDevice: bindStart,
          platformServices,
          bindExactDevice,
          admissionLedger: screenRecordingAdmissionLedger,
          requestScope: scope,
          retainDeviceExecutionLock: holdDevice,
          throwIfCanceled:
            request.phase === 'stop'
              ? throwIfCanceled
              : () => {
                  signal?.throwIfAborted();
                  throwIfRequestCanceled(requestId);
                  throwIfCanceled();
                },
        });
      },
      signal,
    );
  };
  return {
    throwIfCanceled,
    record,
  };
}

function recordRequest(request: ReplayRecordVideoRequest, suite?: DaemonRequest): DaemonRequest {
  return {
    token: request.request.token,
    session: request.sessionName,
    command: 'record',
    positionals: request.phase === 'start' ? ['start', request.outputPath] : ['stop'],
    flags: {},
    meta: {
      ...request.request.meta,
      tenantId: suite?.meta?.tenantId ?? request.request.meta?.tenantId,
    },
    internal: { admittedLease: suite?.internal?.admittedLease },
  };
}
