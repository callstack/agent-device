import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { startAndroidRecording, stopAndroidRecording } from './record-trace-android.ts';
import {
  normalizeAppBundleId,
  startIosDeviceRecording,
  startMacOsRecording,
  stopIosDeviceRecording,
  stopMacOsRecording,
} from './record-trace-ios.ts';
import {
  startIosSimulatorRecording,
  stopIosSimulatorRecording,
} from './record-trace-ios-simulator-recording.ts';
import type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';

type ActiveRecording = NonNullable<SessionState['recording']>;

type RecordingOutputPathContext = {
  req: DaemonRequest;
};

type RecordingStartContext = {
  req: DaemonRequest;
  activeSession: SessionState;
  sessionStore: SessionStore;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  fpsFlag: number | undefined;
  recordingBase: RecordingBase;
  resolvedOut: string;
};

type RecordingStopContext = {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  recording: ActiveRecording;
  stopRequestedAt: number;
};

export type RecordingBackend = {
  resolveOutputPath: (context: RecordingOutputPathContext) => string;
  start: (context: RecordingStartContext) => Promise<DaemonResponse | ActiveRecording>;
  stop: (context: RecordingStopContext) => Promise<DaemonResponse | null>;
};

export function resolveRecordingBackendForDevice(device: SessionState['device']): RecordingBackend {
  if (device.platform === 'android') return androidRecordingBackend;
  if (device.platform === 'macos') return macOsRecordingBackend;
  if (device.platform === 'ios' && device.kind === 'device') return iosDeviceRecordingBackend;
  if (device.platform === 'ios') return iosSimulatorRecordingBackend;
  return unsupportedRecordingBackend;
}

export function resolveRecordingBackendForRecording(recording: ActiveRecording): RecordingBackend {
  switch (recording.platform) {
    case 'android':
      return androidRecordingBackend;
    case 'ios':
      return iosSimulatorRecordingBackend;
    case 'ios-device-runner':
      return iosDeviceRecordingBackend;
    case 'macos-runner':
      return macOsRecordingBackend;
  }

  const exhaustive: never = recording;
  return exhaustive;
}

function resolveNativeRecordingOutputPath({ req }: RecordingOutputPathContext): string {
  const requestedPath = req.positionals?.[1];
  return requestedPath ?? `./recording-${Date.now()}.mp4`;
}

const iosDeviceRecordingBackend: RecordingBackend = {
  resolveOutputPath: resolveNativeRecordingOutputPath,
  start: async ({
    req,
    activeSession,
    sessionStore,
    device,
    logPath,
    deps,
    fpsFlag,
    recordingBase,
  }) => {
    const appBundleId = normalizeAppBundleId(activeSession);
    if (!appBundleId) {
      return errorResponse(
        'INVALID_ARGS',
        'record on physical iOS devices requires an active app session; run open <app> first',
      );
    }
    return await startIosDeviceRecording({
      req,
      activeSession,
      sessionStore,
      device,
      logPath,
      deps,
      fpsFlag,
      recordingBase,
      appBundleId,
    });
  },
  stop: async ({ req, activeSession, device, logPath, deps, recording }) =>
    await stopIosDeviceRecording({
      req,
      activeSession,
      device,
      logPath,
      deps,
      recording: recording as Extract<ActiveRecording, { platform: 'ios-device-runner' }>,
    }),
};

const macOsRecordingBackend: RecordingBackend = {
  resolveOutputPath: resolveNativeRecordingOutputPath,
  start: async ({ req, activeSession, device, logPath, deps, fpsFlag, recordingBase }) => {
    const appBundleId = normalizeAppBundleId(activeSession);
    if (!appBundleId) {
      return errorResponse(
        'INVALID_ARGS',
        'record on macOS requires an active app session; run open <app> first',
      );
    }
    return await startMacOsRecording({
      req,
      activeSession,
      device,
      logPath,
      deps,
      fpsFlag,
      recordingBase,
      appBundleId,
    });
  },
  stop: async ({ req, activeSession, device, logPath, deps, recording }) =>
    await stopMacOsRecording({
      req,
      activeSession,
      device,
      logPath,
      deps,
      recording: recording as Extract<ActiveRecording, { platform: 'macos-runner' }>,
    }),
};

const iosSimulatorRecordingBackend: RecordingBackend = {
  resolveOutputPath: resolveNativeRecordingOutputPath,
  start: async ({ req, activeSession, device, logPath, deps, recordingBase, resolvedOut }) =>
    await startIosSimulatorRecording({
      req,
      activeSession,
      device,
      logPath,
      deps,
      recordingBase,
      resolvedOut,
    }),
  stop: async ({ deps, recording, stopRequestedAt }) =>
    await stopIosSimulatorRecording({
      deps,
      recording: recording as Extract<ActiveRecording, { platform: 'ios' }>,
      stopRequestedAt,
    }),
};

const androidRecordingBackend: RecordingBackend = {
  resolveOutputPath: resolveNativeRecordingOutputPath,
  start: async ({ device, recordingBase }) =>
    await startAndroidRecording({ device, recordingBase }),
  stop: async ({ deps, device, recording, stopRequestedAt }) =>
    await stopAndroidRecording({
      deps,
      device,
      recording: recording as Extract<ActiveRecording, { platform: 'android' }>,
      stopRequestedAt,
    }),
};

const unsupportedRecordingBackend: RecordingBackend = {
  resolveOutputPath: resolveNativeRecordingOutputPath,
  start: async () =>
    errorResponse('UNSUPPORTED_OPERATION', 'record is not supported on this device'),
  stop: async () =>
    errorResponse('UNSUPPORTED_OPERATION', 'record is not supported on this device'),
};
