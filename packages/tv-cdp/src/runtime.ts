import { setTimeout as sleep } from 'node:timers/promises';

import { createProviderAppLogOperations } from '@agent-device/capture-kit/provider-app-log';
import { APP_LOG_RESOURCE_KIND } from '@agent-device/contracts/app-log-runtime';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import type { DeviceLease, LeaseLifecycleContext } from '@agent-device/contracts/device';
import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import {
  providerRuntimeOwner,
  sameRuntimeOwner,
  unavailableFact,
  type DeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  bindProviderScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import {
  bindProviderSnapshotInteractor,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { supportedRemoteButtons } from './keys.ts';
import { createPageInteractor, detachPage } from './page-interactor.ts';
import type { TvPlatform, TvSession } from './tv.ts';

const INSTANCE = 'local';
const available = Object.freeze({ available: true } as const);

type Owner = ReturnType<typeof providerRuntimeOwner>;

export type TvRuntimeHost = Readonly<{
  createError(code: string, message: string, details?: Record<string, unknown>): Error;
}>;

// agent-device has a fixed platform list and leases only ios/android/harmonyos devices, so a TV
// enters as an Android TV device that its provider owns end to end.
function tvDevice(platform: TvPlatform, name: string): DeviceInfo {
  return {
    platform: 'android',
    id: `${platform.provider}:${name}`,
    name,
    kind: 'device',
    target: 'tv',
    booted: true,
  };
}

function tvFacts(platform: TvPlatform, device: DeviceInfo, owner: Owner) {
  const refused = unavailableFact(
    'unsupported-provider-mode',
    `Not supported on ${platform.label}.`,
  );
  const refusedByDefault = createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: refused,
    network: refused,
    screenshot: refused,
    viewport: refused,
    focus: refused,
    gesture: refused,
    scroll: refused,
    typeText: refused,
    touch: refused,
    elementText: refused,
    back: refused,
    orientation: refused,
    fold: refused,
    telephony: refused,
    tvRemote: refused,
    keyboard: refused,
    clipboard: refused,
    systemButton: refused,
    triggerAppEvent: refused,
    settings: refused,
    readAlert: refused,
    awaitAlert: refused,
    acceptAlert: refused,
    dismissAlert: refused,
    audioProbeCapture: refused,
    audioProbeQuery: refused,
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: available,
      prepareApplicationOpen: available,
      openApplication: available,
      applyRuntimeHints: refused,
      clearRuntimeHints: refused,
      closeApplication: available,
      finalizeApplicationClose: available,
      prepareAppleRunner: refused,
      configureProviderPortReverse: refused,
    }),
  });
  const touchFacts = touchRuntimeOperationFacts({
    unsupported: refused,
    tap: available,
    longPress: available,
    hover: available,
    fill: available,
  });
  const operations = Object.freeze({
    ...refusedByDefault.operations,
    ...snapshotRuntimeOperationFacts({
      capture: available,
      customActions: refused,
      withoutActiveApp: refused,
    }),
    ...screenshotRuntimeOperationFacts({ capture: available }),
    ...touchFacts,
    ...focusRuntimeOperationFacts({ focus: available }),
    ...typeTextRuntimeOperationFacts({ type: available }),
    ...scrollRuntimeOperationFacts({ scroll: available }),
    ...backRuntimeOperationFacts({ back: available }),
    ...tvRemoteRuntimeOperationFacts({
      tvRemote: available,
      buttonSupport: {
        supported: supportedRemoteButtons(platform.remoteKeys),
        unsupported: refused,
      },
    }),
    appLogInspect: available,
    appLogDoctor: available,
    appLogStart: available,
    appLogReattach: available,
    appLogCleanup: available,
    listApps: available,
    appState: available,
    ensureReady: available,
    bootTarget: available,
  });
  return {
    touchFacts,
    facts: Object.freeze({
      device: refusedByDefault.device,
      operations,
    }) satisfies RuntimeFacts<PlatformRuntimeOperations>,
  };
}

export function createTvRuntime(platform: TvPlatform, host: TvRuntimeHost) {
  const { provider, label } = platform;
  const devicePrefix = `${provider}:`;
  const sessions = new Map<string, TvSession>();
  const leases = new Map<string, string>();
  const owner = providerRuntimeOwner(provider, INSTANCE);

  const ownsDevice = (device: DeviceInfo) => device.id.startsWith(devicePrefix);
  const tvName = (device: DeviceInfo) => device.id.slice(devicePrefix.length);
  const sessionFor = (device: DeviceInfo) =>
    ownsDevice(device) ? sessions.get(tvName(device)) : undefined;
  const getInteractor = (device: DeviceInfo): Interactor | undefined => {
    const session = sessionFor(device);
    return session && createPageInteractor(session, platform.remoteKeys);
  };

  async function allocate(lease: DeviceLease, context?: LeaseLifecycleContext) {
    if (lease.leaseProvider !== provider) return undefined;
    const leased = leases.get(lease.leaseId);
    if (leased) return { device: tvDevice(platform, leased) };
    const flagDevice = context?.flags?.device;
    const tv = await platform.connectTv(typeof flagDevice === 'string' ? flagDevice : undefined);
    const holder = [...leases].find(([id, name]) => name === tv.name && id !== lease.leaseId);
    if (holder) {
      throw host.createError('DEVICE_IN_USE', `${label} TV ${tv.name} is held by another lease`, {
        hint: 'Disconnect the session that holds the TV, or wait for its lease to expire.',
      });
    }
    if (!sessions.has(tv.name)) sessions.set(tv.name, { tv, label, logs: new Map() });
    leases.set(lease.leaseId, tv.name);
    return { device: tvDevice(platform, tv.name) };
  }

  function releaseLease(leaseId: string) {
    const name = leases.get(leaseId);
    if (!name) return false;
    leases.delete(leaseId);
    const session = sessions.get(name);
    if (session && ![...leases.values()].includes(name)) {
      session.released = true;
      detachPage(session);
      sessions.delete(name);
    }
    return true;
  }

  async function release(lease: DeviceLease) {
    return releaseLease(lease.leaseId) ? {} : undefined;
  }

  const runtime = {
    provider,
    leaseLifecycle: { allocate, release },
    deviceInventoryProvider: async (request: { leaseProvider?: string; leaseId?: string }) => {
      if (request.leaseProvider !== provider || !request.leaseId) return null;
      const name = leases.get(request.leaseId);
      return name ? [tvDevice(platform, name)] : null;
    },
    ownsDevice,
    getInteractor,
    shutdown: async () => {
      for (const leaseId of leases.keys()) releaseLease(leaseId);
    },
  };

  const context: TvRuntimeContext = {
    platform,
    owner,
    ownsDevice,
    tvName,
    getInteractor,
    sessionFor,
  };
  const platformModule = Object.freeze({
    owner,
    loadRuntime: async (platformHost: PlatformRuntimeHost): Promise<PlatformRuntimeOwner> =>
      createTvPlatformRuntime(context, platformHost),
  });

  return { runtime, platformModule };
}

type TvAppLogDescriptor = Readonly<{
  transport: string;
  tv: string;
  appBundleId: string;
  outputPath: string;
}>;

function appLogDescriptorCodec(
  transport: string,
  label: string,
): DurableDescriptorCodec<TvAppLogDescriptor, typeof APP_LOG_RESOURCE_KIND> {
  return Object.freeze({
    resourceKind: APP_LOG_RESOURCE_KIND,
    version: 1,
    encode: (descriptor) => ({ ...descriptor }),
    decode: (body) =>
      body.transport === transport &&
      typeof body.tv === 'string' &&
      typeof body.appBundleId === 'string' &&
      typeof body.outputPath === 'string'
        ? {
            status: 'decoded',
            descriptor: {
              transport,
              tv: body.tv,
              appBundleId: body.appBundleId,
              outputPath: body.outputPath,
            },
          }
        : { status: 'invalid', message: `Invalid ${label} app-log descriptor` },
  });
}

type TvRuntimeContext = Readonly<{
  platform: TvPlatform;
  owner: Owner;
  ownsDevice(device: DeviceInfo): boolean;
  tvName(device: DeviceInfo): string;
  getInteractor(device: DeviceInfo): Interactor | undefined;
  sessionFor(device: DeviceInfo): TvSession | undefined;
}>;

function createTvPlatformRuntime(
  { platform, owner, ownsDevice, tvName, getInteractor, sessionFor }: TvRuntimeContext,
  host: PlatformRuntimeHost,
): PlatformRuntimeOwner {
  const { provider, label } = platform;
  const transport = `${provider}-cdp`;
  const codec = appLogDescriptorCodec(transport, label);
  return Object.freeze({
    owner,
    ownsDevice,
    inspectFacts: async (device) => tvFacts(platform, device, owner).facts,
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          `${label} runtime owner identity does not match`,
        );
      }
      const { device } = request;
      const { signal } = request.scope;
      const { facts, touchFacts } = tvFacts(platform, device, owner);
      const resolveInteractor = () => getInteractor(device);
      const requireSession = () => {
        const session = sessionFor(device);
        if (!session) {
          throw new AppError(
            'COMMAND_FAILED',
            `${label} TV ${tvName(device)} has no active session`,
            {
              hint: `Run connect ${provider}, then open <appId>.`,
            },
          );
        }
        return session;
      };
      const logReader = (session: TvSession) => ({
        readLogs: async (appBundleId: string, lineLimit: number) =>
          session.logs.get(appBundleId)?.tail(lineLimit) ?? '',
        [Symbol.asyncDispose]: async () => undefined,
      });
      const appLogs = createProviderAppLogOperations({
        host,
        device,
        owner,
        signal,
        provider: label,
        backend: 'android',
        sessionCheck: `${provider}SessionAvailable`,
        unavailableMessage: `${label} app logs require an active session. Run open <appId> first.`,
        codec,
        openCurrent: async () => {
          const session = sessionFor(device);
          return session?.page ? logReader(session) : undefined;
        },
        describe: (_reader, target) => ({
          transport,
          tv: tvName(device),
          appBundleId: target.appBundleId,
          outputPath: target.outputPath,
        }),
        matchesDevice: (descriptor) => descriptor.tv === tvName(device),
        reconnect: async (descriptor) => {
          const session = sessionFor(device);
          return session?.page && session.appId === descriptor.appBundleId
            ? { status: 'opened', reader: logReader(session) }
            : { status: 'missing' };
        },
      });
      const lifecycle = bindDirectApplicationLifecycle({
        owner: label,
        openTargetIdentity: 'bundle-id',
        binding: bindProviderApplicationLifecycleInteractor({ device, signal, resolveInteractor }),
      });
      const appOperations: Pick<PlatformRuntimeOperations, 'listApps' | 'appState'> = {
        listApps: async () => await requireSession().tv.listApps(),
        appState: async () => ({ package: await visibleAttachedApp(requireSession()) }),
      };
      return Object.freeze({
        device,
        owner,
        facts,
        operations: Object.freeze({
          ensureReady: async () => device,
          bootTarget: async () => device,
          ...appLogs,
          ...appOperations,
          ...availableApplicationLifecycleOperations(lifecycle, facts.operations),
          ...bindProviderSnapshotInteractor({
            device,
            signal,
            resolveInteractor,
            presentIosAcquisition: host.snapshot.presentIosAcquisition,
          }),
          ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
          ...bindProviderTouchInteractor({
            device,
            signal,
            resolveInteractor,
            facts: touchFacts,
            pause: async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
          }),
          ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
          ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
          ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
          ...bindAdmittedProviderInteractorOperations({
            device,
            signal,
            resolveInteractor,
            facts: facts.operations,
          }),
        }),
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => undefined,
  });
}

async function visibleAttachedApp({ page, appId }: TvSession) {
  if (!page || !appId) return undefined;
  const state = await page.evaluate<string>('document.visibilityState').catch(() => undefined);
  return state === 'visible' ? appId : undefined;
}
