import { vi } from 'vitest';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import type { LaunchObservation } from './snapshot-observability.ts';

/**
 * The app `resolveIosSimulatorDeepLinkBundleId` answers as the launch URL's scheme owner. Each test
 * file mocks that module onto this object, so the owner a case wants is one assignment.
 */
export const urlOwner: { resolve: () => Promise<string | undefined> } = {
  resolve: async () => 'com.example.app',
};

export function resetUrlOwner(): void {
  urlOwner.resolve = async () => 'com.example.app';
}

export const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-device',
  name: 'iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
  iosPhysicalDeviceBackend: 'coredevice',
};

export const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-simulator',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export function openInput(): OpenApplicationInput {
  return {
    target: 'com.example.app',
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
    surface: 'app',
    hasExistingSession: true,
    relaunch: true,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/tmp/agent-device-lifecycle-test',
    runtimeHints: {},
    execution: {},
  };
}

export function simulatorHost(overrides: {
  prewarmRunnerSession?: () => Promise<void>;
  hasLiveRunnerSession?: () => Promise<boolean>;
  events: string[];
}) {
  const interactor = {
    close: vi.fn(async () => {
      overrides.events.push('close');
    }),
    open: vi.fn(async () => {
      overrides.events.push('open');
    }),
  } as unknown as Interactor;
  const baseHost = platformRuntimeHostFixture();
  const prewarmRunnerSession = vi.fn(
    overrides.prewarmRunnerSession ??
      (async () => {
        overrides.events.push('prewarm');
      }),
  );
  const notifyRunnerAppRelaunched = vi.fn(async () => {
    overrides.events.push('reset');
  });
  const hasLiveRunnerSession = vi.fn(overrides.hasLiveRunnerSession ?? (async () => false));
  const releaseSpeculativeRunner = vi.fn(async () => {
    overrides.events.push('release');
    return true;
  });
  const host = {
    ...baseHost,
    clock: { ...baseHost.clock, sleep: async () => {} },
    localInteractors: { resolve: async () => interactor },
    appleApplications: {
      ...baseHost.appleApplications,
      prewarmRunnerSession,
      notifyRunnerAppRelaunched,
      hasLiveRunnerSession,
      releaseSpeculativeRunner,
    },
  } as unknown as PlatformRuntimeHost;
  return {
    host,
    prewarmRunnerSession,
    notifyRunnerAppRelaunched,
    hasLiveRunnerSession,
    releaseSpeculativeRunner,
  };
}

export const LAUNCH_URL = 'example://automation';
export const UNOBSERVABLE: LaunchObservation = {
  observation: 'unobservable',
  proof: 'no-running-process',
};
export const COMING_UP: LaunchObservation = {
  observation: 'unobservable',
  proof: 'launch-transition',
};
export const OBSERVABLE: LaunchObservation = { observation: 'observable' };
export const SPAWN_TIMEOUT = new AppError('COMMAND_FAILED', 'xcrun timed out', {
  timeoutMs: 10_000,
});

export function launchUrlInput(): OpenApplicationInput {
  return {
    ...openInput(),
    runtimeLaunchUrl: LAUNCH_URL,
    execution: { plannedOperations: ['captureSnapshot'] },
  };
}

/**
 * A Simulator whose host AX bridge reports `observations` in turn after each settle, and whose
 * runner answers the alert read with `readAlert`.
 */
export function launchUrlSimulator(
  readAlert: () => Promise<Record<string, unknown>>,
  observations: readonly LaunchObservation[] = [{ observation: 'observable' }],
  legs: Readonly<{
    acceptAlert?: () => Promise<unknown>;
    resolveInteractor?: () => Promise<void>;
    owner?: () => Promise<string | undefined>;
  }> = {},
) {
  if (legs.owner) urlOwner.resolve = legs.owner;
  const events: string[] = [];
  const pending = [...observations];
  const interactor = {
    open: vi.fn(async (_app: string, options?: { url?: string }) => {
      events.push(options?.url ? `open ${options.url}` : 'open');
    }),
    readAlert: vi.fn(async () => {
      events.push('alert get');
      return await readAlert();
    }),
    acceptAlert: vi.fn(async () => {
      events.push('alert accept');
      return await (legs.acceptAlert ?? (async () => ({})))();
    }),
  } as unknown as Interactor;
  let resolutions = 0;
  const { host, releaseSpeculativeRunner, prewarmRunnerSession } = simulatorHost({ events });
  const lifecycle = bindAppleApplicationLifecycle({
    host: {
      ...host,
      localInteractors: {
        resolve: async () => {
          resolutions += 1;
          // The open dispatch resolves first; later resolutions serve the confirmation answer.
          if (resolutions > 1) await legs.resolveInteractor?.();
          return interactor;
        },
      },
    },
    device: simulator,
    signal: new AbortController().signal,
    observation: {
      awaitObservable: async () => {
        const observed = (pending.length > 1 ? pending.shift() : pending[0]) ?? {
          observation: 'observable',
        };
        events.push(`observe ${observed.observation}`);
        return observed;
      },
    },
  });
  return {
    lifecycle,
    events,
    interactor,
    releaseSpeculativeRunner,
    prewarmRunnerSession,
    resolutions: () => resolutions,
  };
}
