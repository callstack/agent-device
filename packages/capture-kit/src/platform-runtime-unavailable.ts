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
  apps?: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording?: RuntimeOperationUnavailability;
  readiness?: RuntimeOperationUnavailability;
}>;

type FrozenUnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  apps: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording: RuntimeOperationUnavailability;
  readiness: RuntimeOperationUnavailability;
}>;

/** Builds one honest combined owner for a family with no app-log or network mechanics. */
export function createUnavailablePlatformRuntimeOwner(
  family: Platform,
  unavailable: UnavailablePlatformRuntimeFacts,
): PlatformRuntimeOwner {
  const owner = localRuntimeOwner(family);
  const facts = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === family,
    inspectFacts: async (device) => createUnavailablePlatformRuntimeFacts(device, owner, facts),
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
      return createUnavailablePlatformRuntimeBinding(request.device, owner, facts);
    },
    shutdown: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeBinding(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): DeviceBinding<PlatformRuntimeOperations> {
  const facts = createUnavailablePlatformRuntimeFacts(device, owner, unavailable);
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze({}),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeFacts(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): RuntimeFacts<PlatformRuntimeOperations> {
  const { appLog, apps, network, screenRecording, readiness } = freezeUnavailableFacts(unavailable);
  return Object.freeze({
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
      listApps: apps,
      networkDump: network,
      screenRecordingStart: screenRecording,
      screenRecordingReattach: screenRecording,
      screenRecordingCleanup: screenRecording,
      ensureReady: readiness,
      bootTarget: readiness,
      bootTargetHeadless: readiness,
    },
  });
}

function freezeUnavailableFacts(
  unavailable: UnavailablePlatformRuntimeFacts,
): FrozenUnavailablePlatformRuntimeFacts {
  return Object.freeze({
    appLog: Object.freeze({ ...unavailable.appLog }),
    apps: Object.freeze({ ...(unavailable.apps ?? unavailable.network) }),
    network: Object.freeze({ ...unavailable.network }),
    screenRecording: Object.freeze({
      ...(unavailable.screenRecording ?? unavailable.network),
    }),
    readiness: Object.freeze({ ...(unavailable.readiness ?? unavailable.network) }),
  });
}
