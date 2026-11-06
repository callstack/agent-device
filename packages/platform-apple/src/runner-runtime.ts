import { createAppleAppDeploymentOperations } from './deployment/runtime.ts';
import type {
  AppleApplicationTools,
  PrepareAppleRunnerInput,
  PrepareAppleRunnerResult,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type AppleRunnerProvider,
  withAppleRunnerProvider,
  prepareIosRunner,
} from '@agent-device/apple-runner';
import { Deadline } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { readRunnerSessionLiveness, runAppleRunnerCommand } from './core/runner-client.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { bindAppleApplicationLifecycleWithServices } from './lifecycle.ts';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { createAppleInteractor } from './interactor.ts';
import { appleRunnerInteractionFacts } from './runner-interaction-facts.ts';
import { bindAppleAppStateRuntime } from './app-state-runtime.ts';
import { bindAppleFindTextRuntime } from './runtime-snapshot.ts';
import { bindAppleQuerySelectorRuntime } from './runtime-selector-query.ts';
import { bindElementTextRuntime } from '@agent-device/contracts/element-text-runtime';
import {
  captureSnapshotSignal,
  type CaptureSnapshotInput,
  type SnapshotRuntimeOperations,
  type SnapshotRuntimePresenter,
} from '@agent-device/contracts/snapshot-runtime';
import { createRunnerSnapshotBridge } from './runner-snapshot-bridge.ts';
import { createSnapshotBridgeRoute, type SnapshotBridgeRoute } from './snapshot-route.ts';
import { createSystemSurfaceForegroundProbe } from './system-surface-foreground.ts';

/** Binds a provider-owned runner session to the shared Apple command and runtime implementation. */
export function createAppleRunnerRuntime(options: {
  device: DeviceInfo;
  host: HostEnvironment;
  provider: AppleRunnerProvider;
}) {
  const runCommand = options.provider;
  const createInteractor = (context: RunnerContext = {}): Interactor => {
    const interactor = createAppleInteractor(options.device, context, options.host, runCommand);
    return {
      ...interactor,
      snapshot: async (input) => {
        // Remote XCTest products target Runner.app; only the caller can name the app under test.
        if (!(input?.appBundleId ?? context.appBundleId)) {
          throw new AppError('INVALID_ARGS', 'Remote Apple snapshots require an app bundle ID', {
            hint: 'Open an app in this session or pass snapshot({ appBundleId }).',
          });
        }
        return await interactor.snapshot(input);
      },
    };
  };
  const bridge = createRunnerSnapshotBridge({ device: options.device, provider: options.provider });
  // Every capture of a remote Simulator reaches the runner, through the bridge or through XCTest. So
  // the foreground read starts a runner that is not up yet, under the capture's own budget, instead
  // of giving up the proof that keeps the capture on the bridge.
  let snapshotRoute: SnapshotBridgeRoute | undefined;
  const readForeground = createSystemSurfaceForegroundProbe(async (device, input) => {
    if (!options.provider.hasLiveSession(device)) {
      try {
        await runAppleRunnerCommand(
          device,
          { command: 'uptime' },
          { signal: input.signal, ...(input.requestId ? { requestId: input.requestId } : {}) },
        );
      } catch {
        input.signal.throwIfAborted();
        return undefined;
      }
    }
    const session = readRunnerSessionLiveness(device.id);
    if (session?.liveness !== 'ready') return undefined;
    return { sessionId: session.sessionId };
  });
  /**
   * The route outlives every request binding: its circuit, depth hints, and cached target describe
   * the app generations this runner has read. The presenter comes with the first binding and is the
   * device host's own, so every later binding hands over the same one.
   */
  const routeFor = (present: SnapshotRuntimePresenter) =>
    (snapshotRoute ??= createSnapshotBridgeRoute(
      {
        snapshot: { presentIosAcquisition: present },
        appleApplications: {
          hasLiveRunnerSession: async () => options.provider.hasLiveSession(options.device),
        },
      },
      {
        source: bridge.source,
        resolveTarget: bridge.resolveTarget,
        // The runner answers the target read itself; there is no detached discovery to wait on.
        isDiscoveryPending: () => false,
        targetFreshness: 'cached',
        sessionChanged: bridge.resetTargets,
      },
      async (device, input) =>
        await withAppleRunnerProvider(
          runCommand,
          { deviceId: device.id, ...(input.requestId ? { requestId: input.requestId } : {}) },
          () => readForeground(device, input),
        ),
    ));
  /**
   * Routes app captures through the runner-served bridge, falling back to the provider's own XCTest
   * capture. An observation-only capture goes to the provider's capture, which decides whether it can
   * observe without activation.
   */
  const bindBridgeSnapshot = (
    signal: AbortSignal,
    snapshot: Readonly<{ capture: SnapshotRuntimeOperations; present: SnapshotRuntimePresenter }>,
  ): SnapshotRuntimeOperations => {
    const route = routeFor(snapshot.present);
    const captureSnapshot = async (input: CaptureSnapshotInput) => {
      if (input.options?.observeOnly === true) return await snapshot.capture.captureSnapshot(input);
      return await route.capture(
        options.device,
        input,
        captureSnapshotSignal(signal, input),
        async (fallbackInput) => await snapshot.capture.captureSnapshot(fallbackInput),
      );
    };
    return Object.freeze({
      captureSnapshot,
      captureSnapshotWithCustomActions: captureSnapshot,
      captureSnapshotWithoutActiveApp: captureSnapshot,
    });
  };
  return {
    facts: appleRunnerInteractionFacts(options.device),
    bindDeployment: (
      request: Omit<Parameters<typeof createAppleAppDeploymentOperations>[0], 'device'>,
    ) => createAppleAppDeploymentOperations({ ...request, device: options.device }),
    createInteractor,
    resetTarget: async (signal?: AbortSignal) => {
      if (!options.provider.hasLiveSession(options.device)) return;
      await withAppleRunnerProvider(runCommand, { deviceId: options.device.id }, () =>
        runAppleRunnerCommand(options.device, { command: 'targetReset' }, { signal }),
      );
    },
    prepare: (
      input: PrepareAppleRunnerInput,
      signal: AbortSignal,
    ): Promise<PrepareAppleRunnerResult> =>
      withAppleRunnerProvider(
        runCommand,
        { deviceId: options.device.id, requestId: input.execution.requestId },
        () =>
          prepareIosRunner(options.device, {
            ...input.execution,
            cleanStaleBundles: true,
            buildTimeoutMs: input.timeoutMs,
            startupTimeoutMs: input.timeoutMs,
            prepareDeadline: Deadline.fromTimeoutMs(input.timeoutMs),
            healthTimeoutMs: input.timeoutMs,
            signal: AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]),
          }),
      ),
    bindApplicationLifecycle: (request: {
      signal: AbortSignal;
      appleApplications: AppleApplicationTools;
      clock: PlatformRuntimeHost['clock'];
      ensureReady: Parameters<
        typeof bindAppleApplicationLifecycleWithServices
      >[0]['host']['ensureReady'];
      resolveInteractor(device: DeviceInfo, context: RunnerContext): Promise<Interactor>;
    }) =>
      bindAppleApplicationLifecycleWithServices({
        device: options.device,
        signal: request.signal,
        host: {
          appleApplications: request.appleApplications,
          clock: request.clock,
          localInteractors: { resolve: request.resolveInteractor },
          ensureReady: request.ensureReady,
          resolveDevClientLaunchUrl: async (device, input) => {
            const { resolveExpoDevClientLaunchUrl } = await import('./expo-dev-client-launch.ts');
            return await resolveExpoDevClientLaunchUrl(device, input);
          },
          runnerFreeObservation: false,
        },
      }),
    bindRunnerOperations: (request: {
      signal: AbortSignal;
      resolveInteractor(device: DeviceInfo, context: RunnerContext): Promise<Interactor>;
      /** The provider's own capture, which the runner-served bridge falls back to. */
      snapshot: Readonly<{ capture: SnapshotRuntimeOperations; present: SnapshotRuntimePresenter }>;
    }) => {
      const host = {
        appleApplications: {
          hasLiveRunnerSession: async () => options.provider.hasLiveSession(options.device),
        },
        localInteractors: { resolve: request.resolveInteractor },
      };
      const params = { ...request, device: options.device };
      const query = bindAppleQuerySelectorRuntime(params);
      return {
        ...bindAppleAppStateRuntime(host, params),
        ...bindAppleFindTextRuntime(host, { ...params, appBackend: 'xctest' }),
        ...bindElementTextRuntime(params),
        querySelector: (input: Parameters<typeof query.querySelector>[0]) =>
          withAppleRunnerProvider(
            runCommand,
            { deviceId: options.device.id, requestId: input.execution?.requestId },
            () => query.querySelector(input),
          ),
        ...bindBridgeSnapshot(request.signal, request.snapshot),
      };
    },
    /** Closes the runner-served bridge source; the runner session itself is the provider's to stop. */
    shutdown: async () => {
      await snapshotRoute?.shutdown();
    },
  };
}
