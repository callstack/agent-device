import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import {
  createUnavailablePlatformRuntimeFacts,
  readRecentNetworkTrafficFromText,
} from '@agent-device/capture-kit';
import { sameRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const available = Object.freeze({ available: true } as const);
const appLogUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose screen recording.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
const appsUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing' as const,
  hint: 'WebDriver provider runtimes do not expose app inventory.',
});

export function createWebDriverPlatformRuntimeOwner(
  options: Readonly<{
    host: PlatformRuntimeHost;
    owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
    ownsDevice(device: DeviceInfo): boolean;
  }>,
): PlatformRuntimeOwner {
  return Object.freeze({
    owner: options.owner,
    ownsDevice: options.ownsDevice,
    inspectFacts: async (device) => webDriverFacts(options.owner, device),
    bind: async (request) => {
      if (
        request.intent.kind === 'exact-owner' &&
        !sameRuntimeOwner(request.intent.owner, options.owner)
      ) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'WebDriver runtime owner identity does not match',
        );
      }
      if (!options.ownsDevice(request.device)) {
        throw new AppError('UNSUPPORTED_PLATFORM', 'WebDriver runtime does not own this device');
      }
      return bindWebDriverPlatformRuntime(options.host, options.owner, request.device);
    },
    shutdown: async () => undefined,
  });
}

function bindWebDriverPlatformRuntime(
  host: PlatformRuntimeHost,
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>,
  device: DeviceInfo,
): DeviceBinding<PlatformRuntimeOperations> {
  const backend = device.platform === 'apple' ? 'ios-device' : 'android';
  const facts = webDriverFacts(owner, device);
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = Object.freeze({
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    networkDump: async (input) => {
      const recent = await host.appLogs.readRecent(input.sessionId, input.maxScanLines);
      const dump = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend,
      });
      return Object.freeze({
        source: 'app-log' as const,
        backend,
        dump,
        notes: Object.freeze(
          dump.entries.length === 0
            ? ['No HTTP(s) entries were found in recent session app logs.']
            : [],
        ),
      });
    },
  });
  return Object.freeze({
    device,
    owner,
    facts,
    operations,
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function webDriverFacts(
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const unavailable = createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: appLogUnavailable,
    network: appLogUnavailable,
    screenRecording: recordingUnavailable,
  });
  return Object.freeze({
    device: unavailable.device,
    operations: {
      appLogInspect: appLogUnavailable,
      appLogDoctor: appLogUnavailable,
      appLogStart: appLogUnavailable,
      appLogReattach: appLogUnavailable,
      appLogCleanup: appLogUnavailable,
      networkDump: available,
      screenRecordingStart: recordingUnavailable,
      screenRecordingReattach: recordingUnavailable,
      screenRecordingCleanup: recordingUnavailable,
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: appsUnavailable,
    },
  });
}
