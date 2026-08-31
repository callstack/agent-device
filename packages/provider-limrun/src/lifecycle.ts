import type {
  ApplicationLifecycleRuntimeOperations,
  CloseApplicationInput,
  OpenApplicationInput,
  OpenTargetResolutionInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { ProviderPortReverseOptions } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';

type LimrunLifecycleParams = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined>;
  resolveAppReference?(app: string): string;
}>;

/** Limrun owns its live-session lifecycle, relaunch, and exact port-reverse mechanics. */
export function bindLimrunApplicationLifecycle(
  params: LimrunLifecycleParams,
): ApplicationLifecycleRuntimeOperations {
  const lifecycle = bindDirectApplicationLifecycle({
    owner: 'Limrun',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
    configureProviderPortReverse: async (input) => await params.configurePortReverse(input),
    binding: bindProviderApplicationLifecycleInteractor({
      device: params.device,
      signal: params.signal,
      resolveInteractor: (runner) => params.getInteractor(params.device, runner),
    }),
  });
  const resolve = params.resolveAppReference;
  if (!resolve) return lifecycle;
  return Object.freeze({
    ...lifecycle,
    resolveOpenTarget: async (input) =>
      await lifecycle.resolveOpenTarget!(resolveOpenTargetInput(input, resolve)),
    openApplication: async (input) =>
      await lifecycle.openApplication!(resolveOpenApplicationInput(input, resolve)),
    closeApplication: async (input) =>
      await lifecycle.closeApplication!(resolveCloseApplicationInput(input, resolve)),
  });
}

function resolveOpenTargetInput(
  input: OpenTargetResolutionInput,
  resolve: (app: string) => string,
): OpenTargetResolutionInput {
  return input.target === undefined ? input : { ...input, target: resolve(input.target) };
}

function resolveOpenApplicationInput(
  input: OpenApplicationInput,
  resolve: (app: string) => string,
): OpenApplicationInput {
  return {
    ...input,
    target: resolveOptionalApp(input.target, resolve),
    positionals: resolveFirstApp(input.positionals, resolve),
    appBundleId: resolveOptionalApp(input.appBundleId, resolve),
  };
}

function resolveCloseApplicationInput(
  input: CloseApplicationInput,
  resolve: (app: string) => string,
): CloseApplicationInput {
  return {
    ...input,
    positionals: resolveFirstApp(input.positionals, resolve),
    appBundleId: resolveOptionalApp(input.appBundleId, resolve),
  };
}

function resolveFirstApp(
  positionals: readonly string[],
  resolve: (app: string) => string,
): readonly string[] {
  const app = positionals[0];
  return app === undefined ? positionals : [resolve(app), ...positionals.slice(1)];
}

function resolveOptionalApp(
  app: string | undefined,
  resolve: (app: string) => string,
): string | undefined {
  return app === undefined ? undefined : resolve(app);
}
