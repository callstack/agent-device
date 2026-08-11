import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import { localRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { bindWebScreenRecordingRuntime } from './recording/runtime.ts';

const owner = localRuntimeOwner('web');
const available = Object.freeze({ available: true } as const);
const appLogUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'record is not supported by this web provider',
} as const);
const readinessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const appsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'apps is not supported on web targets.',
} as const);

export function createWebPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const inspectFacts = async (device: DeviceInfo) => {
    const transport = await host.networkTransports.resolve(device);
    const recording = await bindWebScreenRecordingRuntime({
      host,
      device,
      owner,
      signal: new AbortController().signal,
    });
    return webRuntimeFacts(device, transport, recording.available);
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'web',
    inspectFacts,
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Web runtime owner identity does not match');
      }
      if (request.device.platform !== 'web') {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          `Web runtime owner cannot bind ${request.device.platform}`,
        );
      }
      const transport = await host.networkTransports.resolve(request.device);
      const recording = await bindWebScreenRecordingRuntime({
        host,
        device: request.device,
        owner,
        signal: request.scope.signal,
      });
      return bindWebRuntime(
        request.device,
        request.scope.signal,
        transport,
        recording,
        webRuntimeFacts(request.device, transport, recording.available),
      );
    },
    shutdown: async () => undefined,
  });
}

function bindWebRuntime(
  device: DeviceInfo,
  signal: AbortSignal,
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
  recording: Awaited<ReturnType<typeof bindWebScreenRecordingRuntime>>,
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): DeviceBinding<PlatformRuntimeOperations> {
  const dump = transport.dump;
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = {
    ...(dump
      ? {
          networkDump: async (input) => {
            const result = await dump(
              { maxEntries: input.maxEntries, include: input.include },
              signal,
            );
            return Object.freeze({ source: 'provider' as const, ...result });
          },
        }
      : {}),
    ...recording.operations,
  };
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function webRuntimeFacts(
  device: DeviceInfo,
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
  recordingAvailable: boolean,
): RuntimeFacts<PlatformRuntimeOperations> {
  const networkUnavailable = Object.freeze({
    available: false,
    reason: 'owner-capability-missing',
    hint: 'network is not supported by this web provider',
  } as const);
  return Object.freeze({
    device: {
      family: 'web',
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: transport.mode,
    },
    operations: {
      appLogInspect: appLogUnavailable,
      appLogDoctor: appLogUnavailable,
      appLogStart: appLogUnavailable,
      appLogReattach: appLogUnavailable,
      appLogCleanup: appLogUnavailable,
      networkDump: transport.dump ? available : networkUnavailable,
      screenRecordingStart: recordingAvailable ? available : recordingUnavailable,
      screenRecordingReattach: recordingAvailable ? available : recordingUnavailable,
      screenRecordingCleanup: recordingAvailable ? available : recordingUnavailable,
      ensureReady: readinessUnavailable,
      bootTarget: readinessUnavailable,
      bootTargetHeadless: readinessUnavailable,
      listApps: appsUnavailable,
    },
  });
}
