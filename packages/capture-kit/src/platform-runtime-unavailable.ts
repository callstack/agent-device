import { deviceShape, type DeviceInfo, type Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  localRuntimeOwner,
  sameRuntimeOwner,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type PlatformRuntimeOwner,
  type RuntimeFacts,
  type RuntimeOperationUnavailability,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform';

export type UnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
}>;

/** Builds one honest combined owner for a family with no app-log or network mechanics. */
export function createUnavailablePlatformRuntimeOwner(
  family: Platform,
  unavailable: UnavailablePlatformRuntimeFacts,
): PlatformRuntimeOwner {
  const owner = localRuntimeOwner(family);
  const appLog = Object.freeze({ ...unavailable.appLog });
  const network = Object.freeze({ ...unavailable.network });
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === family,
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          `${family} platform runtime owner identity does not match`,
        );
      }
      if (request.device.platform !== family) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          `${family} platform runtime cannot bind ${request.device.platform}`,
        );
      }
      return createUnavailablePlatformRuntimeBinding(request.device, owner, {
        appLog,
        network,
      });
    },
    shutdown: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeBinding(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): DeviceBinding<PlatformRuntimeOperations> {
  const appLog = Object.freeze({ ...unavailable.appLog });
  const network = Object.freeze({ ...unavailable.network });
  const facts: RuntimeFacts<PlatformRuntimeOperations> = Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: owner.kind === 'local-family' ? 'local' : 'provider-runtime',
    },
    operations: {
      appLogInspect: appLog,
      appLogDoctor: appLog,
      appLogStart: appLog,
      appLogReattach: appLog,
      appLogCleanup: appLog,
      networkDump: network,
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
