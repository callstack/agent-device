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
import { runAppleRunnerCommand } from './core/runner-client.ts';
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
          shutdownTarget: async () => {
            throw new AppError(
              'UNSUPPORTED_OPERATION',
              'The provider owns the simulator lifecycle',
            );
          },
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
      };
    },
  };
}
