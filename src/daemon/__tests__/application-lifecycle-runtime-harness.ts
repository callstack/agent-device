import {
  bindProviderApplicationLifecycleInteractor,
  invokeApplicationClose,
  invokeApplicationOpen,
} from '@agent-device/contracts/application-lifecycle-interaction';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBinding,
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { vi } from 'vitest';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import {
  applicationLifecycleFixtureInteractor,
  applicationLifecycleRuntimeFixture,
} from './application-lifecycle-runtime-fixture.ts';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});

const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const available = Object.freeze({ available: true } as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);

/** Exact lifecycle facts plus a real lazy lifecycle binding for focused handler tests. */
export function lifecycleRuntimeFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  return {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: unavailable,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
      listApps: unavailable,
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: available,
        prepareApplicationOpen: available,
        openApplication: available,
        applyRuntimeHints: available,
        clearRuntimeHints: available,
        closeApplication: available,
        finalizeApplicationClose: available,
        prepareAppleRunner: device.platform === 'apple' ? available : prepareUnavailable,
        configureProviderPortReverse: unavailable,
      }),
    },
  };
}

/** Provider facts deliberately come from the selected runtime owner, never request metadata. */
function providerLifecycleRuntimeFacts(
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const localFacts = lifecycleRuntimeFacts(device);
  return {
    device: { ...localFacts.device, providerMode: 'provider-runtime' },
    operations: {
      ...localFacts.operations,
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: available,
        prepareApplicationOpen: available,
        openApplication: available,
        applyRuntimeHints: unavailable,
        clearRuntimeHints: unavailable,
        closeApplication: available,
        finalizeApplicationClose: available,
        prepareAppleRunner: prepareUnavailable,
        configureProviderPortReverse: available,
      }),
    },
  };
}

async function lifecycleBinding(
  device: DeviceInfo,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts: lifecycleRuntimeFacts(device),
    operations: await applicationLifecycleRuntimeFixture(device),
    [Symbol.asyncDispose]: async () => {},
  };
}

export const inspectLifecycleRuntimeFacts: InspectDeviceRuntimeFacts = async (device) =>
  lifecycleRuntimeFacts(device);

export const bindLifecycleRuntime: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(await lifecycleBinding(device), use);

function providerLifecycleBinding(device: DeviceInfo): DeviceBinding<PlatformRuntimeOperations> {
  const facts = providerLifecycleRuntimeFacts(device);
  return {
    device,
    owner: providerRuntimeOwner('fixture-provider', 'selected-owner'),
    facts,
    operations: applicationLifecycleRuntimeFixtureProviderOperations(device),
    [Symbol.asyncDispose]: async () => {},
  };
}

function applicationLifecycleRuntimeFixtureProviderOperations(
  device: DeviceInfo,
): DeviceBinding<PlatformRuntimeOperations>['operations'] {
  const binding = bindProviderApplicationLifecycleInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: (runner) => applicationLifecycleFixtureInteractor(device, runner),
  });
  return Object.freeze({
    resolveOpenTarget: async ({ target, currentAppBundleId }) => ({
      ...(currentAppBundleId === undefined ? {} : { appBundleId: currentAppBundleId }),
      ...(target === undefined ? {} : { appName: target }),
    }),
    prepareApplicationOpen: async () => undefined,
    openApplication: async (input) => {
      await invokeApplicationOpen({
        device,
        interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
        positionals: input.positionals,
        appBundleId: input.appBundleId,
        execution: input.execution,
      });
      return { appBundleId: input.appBundleId, timing: {} };
    },
    closeApplication: async (input) =>
      await invokeApplicationClose({
        device,
        interactor: await binding.resolveInteractor(input.execution, input.appBundleId),
        positionals: input.positionals,
      }),
    finalizeApplicationClose: async () => ({}),
    configureProviderPortReverse: async () => undefined,
  });
}

export const inspectProviderLifecycleRuntimeFacts: InspectDeviceRuntimeFacts = async (device) =>
  providerLifecycleRuntimeFacts(device);

export const bindProviderLifecycleRuntime: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(providerLifecycleBinding(device), use);
