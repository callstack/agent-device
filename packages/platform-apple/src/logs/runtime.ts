import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AppLogRuntimeHost,
  AppLogRuntimeOperations,
  DeviceBinding,
  DeviceRuntimeOwner,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import {
  appLogSessionArtifactsMatch,
  cleanupManagedAppLogProcess,
  createAppLogRecoveryOperations,
  reattachCleanupOnlyAppLogProcess,
} from '@agent-device/capture-kit';
import { localRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { APPLE_XCTEST_LOGS_HINT, backendForAppleDevice } from './backend.ts';
import { appleAppLogDescriptorCodec } from './descriptor.ts';
import { doctorAppleAppLogs } from './doctor.ts';
import { startAppleAppLogs } from './start.ts';

const owner = localRuntimeOwner('apple');
const available = Object.freeze({ available: true } as const);

export function createAppleAppLogRuntime(
  host: AppLogRuntimeHost,
): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'apple',
    inspectFacts: async (device) => appleAppLogFacts(device),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Apple app-log owner identity does not match');
      }
      return bindAppleAppLogs(host, request.device, request.scope.signal);
    },
    shutdown: async () => undefined,
  });
}

function bindAppleAppLogs(
  host: AppLogRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): DeviceBinding<AppLogRuntimeOperations> {
  if (device.platform !== 'apple') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `Apple app-log owner cannot bind ${device.platform}`,
    );
  }
  const recovery = createAppLogRecoveryOperations({
    codec: appleAppLogDescriptorCodec,
    reattach: async (descriptor, context) => {
      if (
        descriptor.backend !== backendForAppleDevice(device) ||
        !appLogSessionArtifactsMatch(host, context.sessionId, descriptor)
      ) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message: 'Apple app-log descriptor does not match the bound device or owning session',
        };
      }
      return await reattachCleanupOnlyAppLogProcess(host, descriptor.pidPath);
    },
    cleanup: async (descriptor, context) =>
      descriptor.backend === backendForAppleDevice(device) &&
      appLogSessionArtifactsMatch(host, context.sessionId, descriptor)
        ? await cleanupManagedAppLogProcess(host, descriptor.pidPath)
        : {
            status: 'cleanup-pending',
            reason: 'ownership-fence-lost',
            message: 'Apple app-log descriptor does not match the bound device or owning session',
          },
  });
  const operations: AppLogRuntimeOperations = Object.freeze({
    appLogInspect: async () => ({ backend: backendForAppleDevice(device) }),
    appLogDoctor: async ({ appBundleId }) =>
      await doctorAppleAppLogs(host, device, appBundleId, signal),
    appLogStart: async (input) => await startAppleAppLogs(host, device, input, owner, signal),
    ...recovery,
  });
  return Object.freeze({
    device,
    owner,
    facts: appleAppLogFacts(device),
    operations,
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function appleAppLogFacts(device: DeviceInfo): RuntimeFacts<AppLogRuntimeOperations> {
  if (device.appleOs === 'watchos') return unavailableAppleFacts(device);
  const admitted =
    isIosFamily(device) && device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest'
      ? ({
          available: false,
          reason: 'unsupported-device-backend',
          hint: APPLE_XCTEST_LOGS_HINT,
        } as const)
      : available;
  return Object.freeze({
    device: {
      family: 'apple',
      appleOs: device.appleOs,
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      ...(device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
      providerMode: 'local',
    },
    operations: {
      appLogInspect: admitted,
      appLogDoctor: admitted,
      appLogStart: admitted,
      appLogReattach: available,
      appLogCleanup: available,
    },
  });
}

function unavailableAppleFacts(device: DeviceInfo): RuntimeFacts<AppLogRuntimeOperations> {
  const unavailable = Object.freeze({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'watchOS app logs are not supported.',
  } as const);
  return Object.freeze({
    device: {
      family: 'apple',
      appleOs: 'watchos',
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: 'local',
    },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
    },
  });
}
