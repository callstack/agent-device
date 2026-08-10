import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { handleRecordCommand } from './record-runtime.ts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../request-runtime-binding.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform';
import { handleTraceCommand } from './trace-runtime.ts';

export async function handleRecordTraceCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath?: string;
  bindDevice: BindDeviceRuntime;
  bindExactDevice: BindExactDeviceRuntime;
  admissionLedger: ScreenRecordingAdmissionLedger;
  requestScope: PlatformRequestScope;
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  throwIfCanceled(): void;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore } = params;
  const command = req.command;

  if (command === 'record') {
    return handleRecordCommand({
      req,
      sessionName,
      sessionStore,
      bindDevice: params.bindDevice,
      bindExactDevice: params.bindExactDevice,
      admissionLedger: params.admissionLedger,
      requestScope: params.requestScope,
      retainDeviceExecutionLock: params.retainDeviceExecutionLock,
      throwIfCanceled: params.throwIfCanceled,
    });
  }

  if (command === 'trace') {
    return handleTraceCommand({ req, sessionName, sessionStore });
  }

  return null;
}
