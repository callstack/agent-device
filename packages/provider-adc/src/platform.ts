import type { ProviderAndroidHost } from 'agent-device/plugins/device-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  sameRuntimeOwner,
  unavailableFact,
  PLATFORM_RUNTIME_REASONS,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import {
  createFullyUnavailablePlatformRuntimeFacts,
  createUnavailablePlatformRuntimeFacts,
} from '@agent-device/contracts/platform-runtime-unavailable';
import {
  bindProviderInteractionOperations,
  providerAndroidInteractionFacts,
} from '@agent-device/contracts/provider-interaction';
import { INTERACTOR_OPERATIONS } from '@agent-device/contracts/interactor-operation-catalog';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-binding';
import { availableApplicationLifecycleOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import {
  listAndroidAppsWithAdb,
  type AndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';

const available = { available: true } as const;
const unsupported = unavailableFact(PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason);
const unavailable = createFullyUnavailablePlatformRuntimeFacts(unsupported);

export function createPlatformOwner(
  owner: RuntimeOwnerRef,
  runtime: ProviderDeviceRuntime,
  host: PlatformRuntimeHost,
  android: Pick<ProviderAndroidHost, 'getForegroundApp' | 'bindDeployment'>,
  getAdb: (device: DeviceInfo) => AndroidAdbProvider,
  leaseIdFor: (device: DeviceInfo) => string,
): PlatformRuntimeOwner {
  const ownsDevice = runtime.ownsDevice;
  function factsFor(device: DeviceInfo) {
    const base = createUnavailablePlatformRuntimeFacts(device, owner, unavailable);
    if (!ownsDevice(device)) return base;
    return {
      device: base.device,
      operations: {
        ...base.operations,
        ...providerAndroidInteractionFacts(device),
        captureSnapshot: available,
        captureSnapshotWithoutActiveApp: available,
        captureScreenshot: available,
        readTextAtPoint: available,
        resolveOpenTarget: available,
        prepareApplicationOpen: available,
        openApplication: available,
        closeApplication: available,
        finalizeApplicationClose: available,
        listApps: available,
        appState: available,
        ensureReady: available,
        bootTarget: available,
        shutdownTarget: available,
        deployApp: available,
        materializeAppSource: available,
        deployMaterializedApp: available,
        uninstallApp: available,
        sendPushNotification: available,
      },
    };
  }
  return {
    owner,
    ownsDevice,
    inspectFacts: async (device) => factsFor(device),
    async bind({ device, intent, scope }) {
      if (
        !ownsDevice(device) ||
        (intent.kind === 'exact-owner' && !sameRuntimeOwner(intent.owner, owner))
      )
        throw new AppError('DEVICE_NOT_FOUND', 'No active ADC lease owns this device.');
      const facts = factsFor(device);
      const signal = scope.signal;
      const adb = getAdb(device);
      function requireInteractor() {
        const interactor = runtime.getInteractor(device);
        if (!interactor) throw new AppError('DEVICE_NOT_FOUND', 'ADC lease is closed.');
        return interactor;
      }
      const interaction = bindProviderInteractionOperations({
        device,
        signal,
        facts: facts.operations,
        getInteractor: requireInteractor,
        screenshotHint: 'ADC captures the leased Android display.',
      });
      const binding = bindProviderApplicationLifecycleInteractor({
        device,
        signal,
        resolveInteractor: requireInteractor,
      });
      const lifecycle = bindDirectApplicationLifecycle({
        binding,
        owner: 'ADC',
        openTargetIdentity: 'bundle-id',
        closeBeforeRelaunch: true,
      });
      const deployment = await android.bindDeployment(device, adb, {
        host,
        signal,
        async install(artifact, installSignal) {
          if (artifact.installablePath.toLowerCase().endsWith('.aab')) {
            throw new AppError('UNSUPPORTED_OPERATION', 'Install an APK on the ADC device.');
          }
          await adb.exec(['install', '-r', artifact.installablePath], {
            signal: installSignal,
            timeoutMs: 120_000,
          });
          return { packageName: artifact.packageName };
        },
      });
      return {
        owner,
        device,
        facts,
        operations: {
          ...interaction,
          ...deployment,
          ...availableApplicationLifecycleOperations(lifecycle, facts.operations),
          ...bindAdmittedProviderInteractorOperations({
            operations: INTERACTOR_OPERATIONS,
            device,
            signal,
            resolveInteractor: requireInteractor,
            facts: facts.operations,
          }),
          ensureReady: async () => device,
          bootTarget: async () => device,
          shutdownTarget: async ({ releaseLease }) => {
            const leaseId = leaseIdFor(device);
            return await releaseLease(leaseId);
          },
          async listApps({ filter }) {
            const apps = await listAndroidAppsWithAdb(adb.exec, {
              filter,
              target: device.target === 'tv' ? 'tv' : 'mobile',
            });
            return apps.map((app) => ({ id: app.package, name: app.name }));
          },
          async appState() {
            const app = await android.getForegroundApp(adb.exec, signal);
            return { package: app?.appId, activity: app?.activity };
          },
        },
        [Symbol.asyncDispose]: async () => {},
      };
    },
    shutdown: async () => {},
  };
}
