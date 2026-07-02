import fs from 'node:fs';
import path from 'node:path';
import { tryGetPlugin } from '../../core/platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import {
  appendRecordingExtensionWhenMissing,
  defaultRecordingPath,
  WEB_RECORDING_EXTENSION,
} from '../../recording/output-path.ts';
import { resolveWebProvider } from '../../platforms/web/provider.ts';
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

// The plugin registry is consulted by `resolveRecordingBackendForDevice` below;
// register the builtin plugins on load so the lookup is populated (idempotent,
// mirrors src/daemon/app-log.ts and src/daemon/handlers/session-perf.ts).
registerBuiltinPlatformPlugins();

/**
 * The daemon-owned recording-backend discriminant (issue #974). A PLATFORM-NEUTRAL
 * string tag naming which recording backend a device resolves to; the daemon maps it
 * back to the concrete {@link RecordingBackend} instance via `RECORDING_BACKENDS_BY_TAG`.
 * The {@link PlatformPlugin.recording} facet returns this tag (type-only in the plugin,
 * exactly like {@link LogBackend} for app-log), so core/platforms never construct the
 * daemon-owned backend objects. `'unsupported'` is the fallthrough for families that
 * carry no recording facet (linux) and any unregistered platform.
 */
export type RecordingBackendTag =
  | 'web'
  | 'android'
  | 'macos'
  | 'ios-device'
  | 'ios-simulator'
  | 'unsupported';

type ActiveRecording = NonNullable<SessionState['recording']>;
type RecordingPlatform = ActiveRecording['platform'];
type RecordingFor<P extends RecordingPlatform> = Extract<ActiveRecording, { platform: P }>;

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

type RecordingStopContext<P extends RecordingPlatform = RecordingPlatform> = {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  recording: RecordingFor<P>;
  stopRequestedAt: number;
};

// A backend is parameterized by the recording tag it owns, so its `stop` receives an
// already-narrowed recording — no `recording as Extract<ActiveRecording, ...>` casts.
// `start` stays wide because the device platform does not map 1:1 to a recording tag
// (e.g. an iOS device resolves to either the `ios` or `ios-device-runner` recording).
export type RecordingBackend<P extends RecordingPlatform = RecordingPlatform> = {
  validateStart?: (req: DaemonRequest) => DaemonResponse | null;
  resolveOutputPath: (context: RecordingOutputPathContext) => string;
  start: (context: RecordingStartContext) => Promise<DaemonResponse | ActiveRecording>;
  stop: (context: RecordingStopContext<P>) => Promise<DaemonResponse | null>;
  cleanupRecordOnlySession?: (session: SessionState) => Promise<void>;
};

// Device-resolution view: a backend selected before any recording exists exposes only the
// start/output/cleanup surface; stop is dispatched per active recording's tag via
// stopActiveRecording, which is why omitting it keeps the per-tag backends assignable here.
type RecordingStartBackend = Omit<RecordingBackend, 'stop'>;

export function resolveRecordingBackendForDevice(
  device: SessionState['device'],
): RecordingStartBackend {
  // Routes the per-platform branch through the PlatformPlugin recording facet (issue
  // #974): web/android/apple carry a `recording.resolveBackendTag`; linux (and any
  // unregistered platform) fall through to `'unsupported'`, matching the former hand
  // branch's default. The daemon owns the backend instances and maps the neutral tag
  // back to them here. The recording-plugin routing parity test pins the equivalence.
  const tag = tryGetPlugin(device.platform)?.recording?.resolveBackendTag(device) ?? 'unsupported';
  return RECORDING_BACKENDS_BY_TAG[tag];
}

export function stopActiveRecording(context: RecordingStopContext): Promise<DaemonResponse | null> {
  const { recording } = context;
  switch (recording.platform) {
    case 'android':
      return androidRecordingBackend.stop({ ...context, recording });
    case 'ios':
      return iosSimulatorRecordingBackend.stop({ ...context, recording });
    case 'ios-device-runner':
      return iosDeviceRecordingBackend.stop({ ...context, recording });
    case 'macos-runner':
      return macOsRecordingBackend.stop({ ...context, recording });
    case 'web':
      return webRecordingBackend.stop({ ...context, recording });
  }

  const exhaustive: never = recording;
  return exhaustive;
}

function resolveNativeRecordingOutputPath({ req }: RecordingOutputPathContext): string {
  const requestedPath = req.positionals?.[1];
  return requestedPath ?? defaultRecordingPath(undefined);
}

function resolveWebRecordingOutputPath({ req }: RecordingOutputPathContext): string {
  const requestedPath = req.positionals?.[1];
  return requestedPath === undefined
    ? defaultRecordingPath('web')
    : appendRecordingExtensionWhenMissing(requestedPath, WEB_RECORDING_EXTENSION);
}

const webRecordingBackend: RecordingBackend<'web'> = {
  validateStart: (req) => validateWebRecordingFlags(req),
  resolveOutputPath: resolveWebRecordingOutputPath,
  start: async ({ activeSession, recordingBase, resolvedOut }) => {
    const startError = validateWebRecordingOutputPath(resolvedOut);
    if (startError) {
      return startError;
    }
    if (activeSession.recordOnlySession) {
      return errorResponse(
        'INVALID_ARGS',
        'record on web requires an active browser session; run open <url> --platform web first',
      );
    }
    const provider = resolveWebProvider();
    if (!provider.startRecording) {
      return errorResponse('UNSUPPORTED_OPERATION', 'record is not supported by this web provider');
    }
    await provider.startRecording(resolvedOut);
    return {
      ...recordingBase,
      outPath: resolvedOut,
      startedAt: Date.now(),
      platform: 'web',
      showTouches: false,
    };
  },
  stop: async ({ recording }) => await stopWebRecording({ recording }),
  cleanupRecordOnlySession: async () => {
    try {
      await resolveWebProvider().close();
    } catch {
      // Best effort cleanup; deleting the daemon session still releases agent-device state.
    }
  },
};

const iosDeviceRecordingBackend: RecordingBackend<'ios-device-runner'> = {
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
      recording,
    }),
};

const macOsRecordingBackend: RecordingBackend<'macos-runner'> = {
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
      recording,
    }),
};

const iosSimulatorRecordingBackend: RecordingBackend<'ios'> = {
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
      recording,
      stopRequestedAt,
    }),
};

const androidRecordingBackend: RecordingBackend<'android'> = {
  resolveOutputPath: resolveNativeRecordingOutputPath,
  start: async ({ device, recordingBase }) =>
    await startAndroidRecording({ device, recordingBase }),
  stop: async ({ deps, device, recording, stopRequestedAt }) =>
    await stopAndroidRecording({
      deps,
      device,
      recording,
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

// Maps the neutral {@link RecordingBackendTag} the plugin facet returns back to the
// daemon-owned backend instance. Exhaustive over the tag union (a compile error if a
// tag is added without a backend), so `resolveRecordingBackendForDevice` is a pure
// data lookup with no platform branch of its own.
const RECORDING_BACKENDS_BY_TAG: Record<RecordingBackendTag, RecordingStartBackend> = {
  web: webRecordingBackend,
  android: androidRecordingBackend,
  macos: macOsRecordingBackend,
  'ios-device': iosDeviceRecordingBackend,
  'ios-simulator': iosSimulatorRecordingBackend,
  unsupported: unsupportedRecordingBackend,
};

function webRecordingUnsupportedFlags(req: DaemonRequest): string[] {
  const unsupported: string[] = [];
  if (req.flags?.fps !== undefined) unsupported.push('--fps');
  if (req.flags?.quality !== undefined) unsupported.push('--quality');
  if (req.flags?.screenshotMaxSize !== undefined) unsupported.push('--max-size');
  if (req.flags?.hideTouches !== undefined) unsupported.push('--hide-touches');
  return unsupported;
}

function validateWebRecordingFlags(req: DaemonRequest): DaemonResponse | null {
  const unsupportedWebFlags = webRecordingUnsupportedFlags(req);
  if (unsupportedWebFlags.length > 0) {
    return errorResponse(
      'INVALID_ARGS',
      `web recordings do not support ${unsupportedWebFlags.join(', ')}; agent-browser records WebM directly`,
    );
  }
  return null;
}

function validateWebRecordingOutputPath(outPath: string): DaemonResponse | null {
  if (path.extname(outPath).toLowerCase() !== WEB_RECORDING_EXTENSION) {
    return errorResponse(
      'INVALID_ARGS',
      `web recordings must use a ${WEB_RECORDING_EXTENSION} output path`,
    );
  }
  return null;
}

function removeInvalidRecordingOutput(outPath: string): void {
  try {
    fs.rmSync(outPath, { force: true });
  } catch {
    // Best effort: the error response still reports the failed finalization.
  }
}

async function stopWebRecording(params: {
  recording: Extract<ActiveRecording, { platform: 'web' }>;
}): Promise<DaemonResponse | null> {
  const { recording } = params;
  const provider = resolveWebProvider();
  if (!provider.stopRecording) {
    return errorResponse('UNSUPPORTED_OPERATION', 'record is not supported by this web provider');
  }
  await provider.stopRecording();
  if (!hasNonEmptyFile(recording.outPath)) {
    removeInvalidRecordingOutput(recording.outPath);
    return errorResponse(
      'COMMAND_FAILED',
      `failed to stop recording: ${recording.outPath} was not finalized into a WebM video`,
    );
  }
  return null;
}

function hasNonEmptyFile(outPath: string): boolean {
  try {
    return fs.statSync(outPath).size > 0;
  } catch {
    return false;
  }
}
