import type { AndroidClipboardShellSupport } from '@agent-device/contracts/android-clipboard-support';
import type { DeviceBinding } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';

export const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

export const UNKNOWN_KIND_DEVICE = {
  ...ANDROID_EMULATOR,
  kind: 'unknown',
} as unknown as DeviceInfo;

const audioProbeHost: PlatformRuntimeHost['audioProbe'] = {
  hostCapture: {
    info: {
      source: 'system-audio',
      backend: 'fixture',
      sourceCount: 0,
      notes: () => [],
    },
    start: async () => {
      throw new Error('Audio probe is outside this runtime fixture.');
    },
    inspectProcess: async () => 'missing',
    terminateProcess: async () => 'already-missing',
  },
  web: { resolve: async () => undefined },
  ownedProcesses: { replace: () => {}, clear: () => {} },
};

function localAndroidScreenRecording() {
  return {
    mode: 'local' as const,
    start: async () => {
      throw new Error('unused');
    },
    signal: async () => true,
    isRunning: async () => false,
    exists: async () => false,
    pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    remove: async () => true,
    readManifest: async () => undefined,
    writeManifest: async () => {},
    removeManifest: async () => {},
  };
}

/** The smallest host the Android runtime binds against; `overrides` replace whole facets. */
export function androidRuntimeHost(overrides: Record<string, unknown> = {}): PlatformRuntimeHost {
  return {
    androidTools: { probeClipboardShellSupport: async () => 'supported' as const },
    processTransports: { resolve: async () => ({ mode: 'local' as const }) },
    localInteractors: { resolve: async () => ({}) },
    audioProbe: audioProbeHost,
    screenRecording: { android: { resolve: async () => localAndroidScreenRecording() } },
    ...overrides,
  } as unknown as PlatformRuntimeHost;
}

/** A host with app state and device readiness, so navigation and clipboard cells can bind. */
export function androidNavigationHost(
  probeClipboardShellSupport: () => Promise<AndroidClipboardShellSupport> = async () => 'supported',
): PlatformRuntimeHost {
  return androidRuntimeHost({
    androidTools: {
      probeClipboardShellSupport,
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    deviceReadiness: { android: { ensureReady: async (selected: DeviceInfo) => selected } },
  });
}

export async function bindOrdinary(
  runtime: PlatformRuntimeOwner,
  device: DeviceInfo,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  return await runtime.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
}
