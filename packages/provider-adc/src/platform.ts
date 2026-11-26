import { setTimeout as sleep } from 'node:timers/promises';
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
  loadProviderAndroidInteractionFacts,
} from '@agent-device/capture-kit/provider-interaction';
import { INTERACTOR_OPERATIONS } from '@agent-device/contracts/interactor-operation-catalog';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-binding';
import { availableApplicationLifecycleOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import {
  listAndroidAppsWithAdb,
  loadAndroidClipboardSupport,
} from '@agent-device/platform-android/mechanics';

import type { AdcSession } from './runtime.ts';

const available = { available: true } as const;
const unsupported = unavailableFact(PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason);
const unavailable = createFullyUnavailablePlatformRuntimeFacts(unsupported);

export async function createPlatformOwner(
  owner: RuntimeOwnerRef,
  runtime: ProviderDeviceRuntime,
  host: PlatformRuntimeHost,
  android: Pick<ProviderAndroidHost, 'getForegroundApp' | 'bindDeployment'>,
  sessionFor: (device: DeviceInfo) => AdcSession,
): Promise<PlatformRuntimeOwner> {
  const [providerAndroidInteractionFacts, clipboardSupport] = await Promise.all([
    loadProviderAndroidInteractionFacts(),
    loadAndroidClipboardSupport(),
  ]);
  const ownsDevice = runtime.ownsDevice;
  async function probeClipboard(session: AdcSession) {
    try {
      const signal = AbortSignal.timeout(5_000);
      const support = await clipboardSupport.probeAndroidClipboardShellSupport(
        session.adb.exec,
        signal,
      );
      if (support !== 'probe-failed') session.clipboardSupport = support;
    } finally {
      delete session.clipboardProbe;
    }
  }

  function factsFor(device: DeviceInfo) {
    const base = createUnavailablePlatformRuntimeFacts(device, owner, unavailable);
    if (!ownsDevice(device)) return base;
    const session = sessionFor(device);
    const support = session.clipboardSupport ?? 'probe-failed';
    const clipboard = clipboardSupport.androidClipboardRuntimeFact(support);
    return {
      device: base.device,
      operations: {
        ...base.operations,
        ...providerAndroidInteractionFacts(device, clipboard),
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
    async inspectFacts(device, requested) {
      if (
        ownsDevice(device) &&
        (requested?.includes('readClipboard') || requested?.includes('writeClipboard'))
      ) {
        const session = sessionFor(device);
        if (session.clipboardSupport === undefined) {
          session.clipboardProbe ??= probeClipboard(session);
          await session.clipboardProbe;
        }
      }
      return factsFor(device);
    },
    async bind({ device, intent, scope }) {
      if (
        !ownsDevice(device) ||
        (intent.kind === 'exact-owner' && !sameRuntimeOwner(intent.owner, owner))
      )
        throw new AppError('DEVICE_NOT_FOUND', 'No active ADC lease owns this device.');
      const facts = factsFor(device);
      const signal = scope.signal;
      const { adb } = sessionFor(device);
      function requireInteractor() {
        const interactor = runtime.getInteractor(device);
        if (!interactor) throw new AppError('DEVICE_NOT_FOUND', 'ADC lease is closed.');
        return interactor;
      }
      const interaction = bindProviderInteractionOperations({
        pause: (milliseconds) => sleep(milliseconds, undefined, { signal }),
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
            const { leaseId } = sessionFor(device);
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
