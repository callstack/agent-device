import { handleRecordCommand } from './record-runtime.ts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../request-runtime-binding.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DaemonRequest } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import type { ReplayTestVideoOwner } from '../replay/index.ts';

type ReplayRecordVideoRequest = Parameters<ReplayTestVideoOwner['record']>[0];

export type ReplayTestVideoOwnerParams = Readonly<{
  sessionStore: SessionStore;
  bindDevice?: BindDeviceRuntime;
  bindExactDevice?: BindExactDeviceRuntime;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  requestScope?: PlatformRequestScope;
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  throwIfCanceled?: () => void;
}>;

export function createReplayTestVideoOwner(
  params: ReplayTestVideoOwnerParams,
): ReplayTestVideoOwner | undefined {
  const {
    sessionStore,
    bindDevice,
    bindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock,
    throwIfCanceled,
  } = params;
  if (
    !bindDevice ||
    !bindExactDevice ||
    !screenRecordingAdmissionLedger ||
    !requestScope ||
    !retainDeviceExecutionLock ||
    !throwIfCanceled
  ) {
    return undefined;
  }
  const record: ReplayTestVideoOwner['record'] = async (request) =>
    await handleRecordCommand({
      req: recordRequest(request),
      sessionName: request.sessionName,
      sessionStore,
      bindDevice,
      bindExactDevice,
      admissionLedger: screenRecordingAdmissionLedger,
      requestScope,
      retainDeviceExecutionLock,
      throwIfCanceled,
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
