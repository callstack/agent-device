import { deviceShape, type DeviceInfo, type Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  localRuntimeOwner,
  sameRuntimeOwner,
  type AppLogRuntimeOperations,
  type DeviceBinding,
  type DeviceRuntimeOwner,
  type RuntimeFacts,
  type RuntimeOperationUnavailability,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform';

/** Builds an honest family owner for platforms with no app-log mechanics. */
export function createUnavailableAppLogRuntimeOwner(
  family: Platform,
  fact: RuntimeOperationUnavailability,
): DeviceRuntimeOwner<AppLogRuntimeOperations> {
  const owner = localRuntimeOwner(family);
  const unavailable = Object.freeze({ ...fact });
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === family,
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          `${family} app-log owner identity does not match`,
        );
      }
      if (request.device.platform !== family) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          `${family} app-log owner cannot bind ${request.device.platform}`,
        );
      }
      return createUnavailableAppLogBinding(request.device, owner, unavailable);
    },
    shutdown: async () => undefined,
  });
}

/** Builds the complete fact-only binding shared by unavailable local and provider owners. */
export function createUnavailableAppLogBinding(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  fact: RuntimeOperationUnavailability,
): DeviceBinding<AppLogRuntimeOperations> {
  const unavailable = Object.freeze({ ...fact });
  const facts: RuntimeFacts<AppLogRuntimeOperations> = Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: owner.kind === 'local-family' ? 'local' : 'provider-runtime',
    },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
    },
  });
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze({}),
    [Symbol.asyncDispose]: async () => undefined,
  });
}
