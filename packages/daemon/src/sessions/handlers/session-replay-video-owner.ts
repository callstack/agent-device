import { throwIfRequestCanceled } from '@agent-device/host-kit/request';
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
  const record: ReplayTestVideoOwner['record'] = async (request) =>
    await withSessionExecutionLock(request.sessionName, async (holdDevice) => {
      const ref = sessionRef(request.sessionName, request.phase);
      if (!ref) return { ok: true, data: {} };
      await holdDevice(ref.session.device.id);
      return await handleRecordCommand({
        req: recordRequest(request),
        sessionName: ref.address,
        sessionRef: ref,
        sessionStore,
        bindDevice,
        platformServices,
        bindExactDevice,
        admissionLedger: screenRecordingAdmissionLedger,
        requestScope,
        retainDeviceExecutionLock: holdDevice,
        throwIfCanceled:
          request.phase === 'stop'
            ? throwIfCanceled
            : () => {
                throwIfRequestCanceled(request.request.meta?.requestId);
                throwIfCanceled();
              },
      });
    });
  return {
    throwIfCanceled,
    record,
  };
}

function recordRequest(request: ReplayRecordVideoRequest): DaemonRequest {
  return {
    token: request.request.token,
    session: request.sessionName,
    command: 'record',
    positionals: request.phase === 'start' ? ['start', request.outputPath] : ['stop'],
    flags: {},
    meta: request.request.meta,
  };
}
