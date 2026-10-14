import type { ApplicationLifecycleRuntimeOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import type { DeviceBinding } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { vi } from 'vitest';
// The lifecycle seams (dispatch spy, readiness pause, fixture interactor) have ONE owner: the
// daemon's canned lifecycle fixture. This real-composition fixture builds the REAL root gateway
// and platform application tools on top of the same seams, so every lane observes one spy set.
// Android readiness discovery is the composed owners' rule (which devices discovery runs for),
// so its already-running-emulator seam lives HERE, not in the daemon fixture.
export {
  awaitFixtureReadiness,
  dispatchApplicationLifecycleEffect,
} from '@agent-device/daemon/testing/__tests__/application-lifecycle-runtime-fixture';
import {
  applicationLifecycleFixtureInteractor,
  awaitFixtureReadiness,
} from '@agent-device/daemon/testing/__tests__/application-lifecycle-runtime-fixture';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { createAndroidApplicationTools } from '../../platform-runtime-android-application-tools.ts';
import { createAppleApplicationTools } from '../../platform-runtime-apple-application-tools.ts';
import { createComposedPlatformRuntimeGateway } from '../../platform-runtime-gateway.ts';
import { platformRuntimeModules } from '../../platform-runtime.ts';

/**
 * Readiness discovery, as a seam for the composed host. It reports the device under test as an
 * already-running emulator so composition fixtures never launch or poll a boot; a test that needs
 * a pre-effect readiness failure rejects this instead.
 */
export const discoverReadyAndroidEmulators = vi.fn(async (readyDevice: DeviceInfo) => [
  {
    ...readyDevice,
    id: readyDevice.id.startsWith('emulator-') ? readyDevice.id : `emulator-${readyDevice.id}`,
    booted: true,
  },
]);

export async function composedLifecycleRuntimeFixture(
  device: DeviceInfo,
  signal: AbortSignal = new AbortController().signal,
  shutdownTarget: (device: DeviceInfo) => Promise<TargetShutdownResult> = async () => ({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  }),
): Promise<ApplicationLifecycleRuntimeOperations> {
  const gateway = createComposedPlatformRuntimeGateway({
    modules: platformRuntimeModules,
    loadHost: async () => fixtureHost(device, shutdownTarget),
  });
  const binding = await gateway.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: { signal, diagnostics: { emit: () => {} }, progress: { report: () => {} } },
  });
  return lifecycleOperations(binding);
}

function lifecycleOperations(
  binding: DeviceBinding<PlatformRuntimeOperations>,
): ApplicationLifecycleRuntimeOperations {
  const operations = binding.operations;
  const keys = [
    'resolveOpenTarget',
    'prepareApplicationOpen',
    'openApplication',
    'applyRuntimeHints',
    'clearRuntimeHints',
    'closeApplication',
    'finalizeApplicationClose',
    'prepareAppleRunner',
    'configureProviderPortReverse',
  ] as const satisfies readonly (keyof ApplicationLifecycleRuntimeOperations)[];
  const selected = Object.fromEntries(
    keys.flatMap((key) => {
      const operation = operations[key];
      return operation ? [[key, operation]] : [];
    }),
  );
  return Object.freeze(selected) as ApplicationLifecycleRuntimeOperations;
}

function fixtureHost(
  readyDevice: DeviceInfo,
  shutdownTarget: (device: DeviceInfo) => Promise<TargetShutdownResult>,
): PlatformRuntimeHost {
  let simulatorState = readyDevice.booted === false ? 'Shutdown' : 'Booted';
  const localInteractors = Object.freeze({
    resolve: async (device: DeviceInfo, runner: RunnerContext): Promise<Interactor> =>
      applicationLifecycleFixtureInteractor(device, runner),
  });
  return {
    localInteractors,
    appleApplications: createAppleApplicationTools(),
    androidApplications: createAndroidApplicationTools(),
    deviceShutdown: Object.freeze({
      apple: Object.freeze({
        shutdownTarget: async (device: DeviceInfo) => await shutdownTarget(device),
      }),
      android: Object.freeze({
        shutdownTarget: async (device: DeviceInfo) => await shutdownTarget(device),
      }),
      close: Object.freeze({
        canShutdownTarget: async (device: DeviceInfo) =>
          (device.platform === 'apple' && device.kind === 'simulator') ||
          (device.platform === 'android' && device.kind === 'emulator'),
        shutdownTarget: async (device: DeviceInfo) => await shutdownTarget(device),
      }),
    }),
    // Readiness is package-owned; these handler fixtures exercise lifecycle dispatch, so the
    // narrow ports report an already-ready device instead of booting anything.
    deviceReadiness: Object.freeze({
      applePhysical: Object.freeze({
        ensureConnected: async (_device: DeviceInfo, signal: AbortSignal) => {
          signal.throwIfAborted();
        },
      }),
      appleAutomation: Object.freeze({
        keepHot: () => undefined,
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      }),
      androidEmulator: Object.freeze({
        discover: async (_request: unknown, signal: AbortSignal) => {
          signal.throwIfAborted();
          await awaitFixtureReadiness(readyDevice);
          return await discoverReadyAndroidEmulators(readyDevice);
        },
        launch: async () => 1,
        terminate: async () => undefined,
      }),
    }),
    // Readiness reads the device's own boot state, so a `booted: false` fixture still exercises
    // the cold-boot path (and its runner-cache prewarm hook) before settling.
    appleTools: Object.freeze({
      isXcrunAvailable: async () => true,
      run: async (request: Readonly<{ args: readonly string[] }>) => {
        await awaitFixtureReadiness(readyDevice);
        if (request.args.includes('boot')) {
          simulatorState = 'Booted';
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return {
          stdout: JSON.stringify({
            devices: { fixture: [{ udid: readyDevice.id, state: simulatorState }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    }),
    commands: Object.freeze({
      which: async (executable: string) => executable,
      run: async () => ({ stdout: '1', stderr: '', exitCode: 0 }),
    }),
    toolchains: Object.freeze({ prepare: async () => undefined }),
    clock: Object.freeze({
      now: () => Date.now(),
      sleep: async () => undefined,
    }),
    processTransports: Object.freeze({
      resolve: async () => ({ mode: 'local' as const }),
    }),
    networkTransports: Object.freeze({
      resolve: async () => ({ mode: 'local' as const }),
    }),
    screenRecording: Object.freeze({
      apple: Object.freeze({
        availability: async () => ({
          available: false as const,
          hint: 'Screen recording is outside this lifecycle fixture.',
        }),
      }),
      android: Object.freeze({ resolve: async () => ({}) }),
      web: Object.freeze({ resolve: async () => undefined }),
    }),
    audioProbe: Object.freeze({
      hostCapture: Object.freeze({
        info: Object.freeze({
          source: 'system-audio' as const,
          backend: 'fixture',
          sourceCount: 0,
          notes: () => [],
        }),
        start: async () => {
          throw new Error('Audio probe is outside this lifecycle fixture.');
        },
        inspectProcess: async () => 'missing' as const,
        terminateProcess: async () => 'already-missing' as const,
      }),
      web: Object.freeze({ resolve: async () => undefined }),
      ownedProcesses: Object.freeze({ replace: () => {}, clear: () => {} }),
    }),
  } as unknown as PlatformRuntimeHost;
}
