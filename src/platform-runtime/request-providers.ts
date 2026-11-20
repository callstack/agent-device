import type {
  PlatformGatedProviderResolverKey,
  PlatformProviderRequestContext,
  RequestPlatformProviderScope,
  RequestPlatformProviders,
} from '@agent-device/contracts/platform-providers';
import type {
  AndroidAdbExecutor,
  AndroidAdbProvider,
} from '@agent-device/platform-android/mechanics';
import type { AppleRunnerCommandExecutor, AppleRunnerProvider } from '@agent-device/apple-runner';
import type { WebProvider } from '@agent-device/contracts/web-provider';
import type { WebPlatformSelection } from '@agent-device/contracts/platform-plugin';
import type { AppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import type { LinuxToolProvider } from '@agent-device/platform-linux';
import type { VegaToolProvider } from '@agent-device/platform-vega';
import { webBackendKeyOf, type DeviceInfo } from '@agent-device/kernel/device';
import type { AppleSimulatorScreenRecordingTransport } from '../platform-runtime-screen-recording-apple-transport.ts';
import type { AppleRunnerScreenRecordingTransport } from '../platform-runtime-screen-recording-apple-runner-transport.ts';
import { builtinPlatformPlugins } from '../core/interactors/builtin-platform-plugin-set.ts';
import { loadAndroidMechanics } from '../platform-runtime-android-mechanics.ts';

export type PlatformProviderResolver<TResult> = (
  context: PlatformProviderRequestContext,
) => TResult;

export type AndroidAdbProviderResolver = PlatformProviderResolver<
  AndroidAdbProvider | AndroidAdbExecutor | undefined
>;

export type AppleRunnerProviderResolver = PlatformProviderResolver<
  AppleRunnerProvider | AppleRunnerCommandExecutor | undefined
>;

export type AppleToolProviderResolver = PlatformProviderResolver<AppleToolProvider | undefined>;

export type LinuxToolProviderResolver = PlatformProviderResolver<LinuxToolProvider | undefined>;

export type VegaToolProviderResolver = PlatformProviderResolver<VegaToolProvider | undefined>;

export type WebProviderResolver = PlatformProviderResolver<WebProvider | undefined>;

export type AppleSimulatorScreenRecordingTransportResolver = PlatformProviderResolver<
  AppleSimulatorScreenRecordingTransport | undefined
>;

export type AppleRunnerScreenRecordingTransportResolver = PlatformProviderResolver<
  AppleRunnerScreenRecordingTransport | undefined
>;

export type PlatformProviderResolvers = {
  androidAdbProvider?: AndroidAdbProviderResolver;
  appleRunnerProvider?: AppleRunnerProviderResolver;
  appleToolProvider?: AppleToolProviderResolver;
  linuxToolProvider?: LinuxToolProviderResolver;
  vegaToolProvider?: VegaToolProviderResolver;
  webProvider?: WebProviderResolver;
  appleRunnerScreenRecordingTransport?: AppleRunnerScreenRecordingTransportResolver;
  appleSimulatorScreenRecordingTransport?: AppleSimulatorScreenRecordingTransportResolver;
};

export type RequestPlatformProviderOptions = Readonly<{
  providers?: PlatformProviderResolvers;
  web?: WebPlatformSelection;
}>;

type ResolvedRequestPlatformProviders = {
  androidAdb?: {
    provider?: AndroidAdbProvider | AndroidAdbExecutor;
    executor?: AndroidAdbExecutor;
    serial?: string;
  };
  appleRunner?: {
    provider?: AppleRunnerProvider | AppleRunnerCommandExecutor;
    deviceId?: string;
    requestId?: string;
  };
  appleTool?: { provider?: AppleToolProvider };
  linuxTool?: { provider?: LinuxToolProvider };
  vegaTool?: { provider?: VegaToolProvider };
  web?: { provider?: WebProvider };
  appleSimulatorScreenRecording?: { provider?: AppleSimulatorScreenRecordingTransport };
  appleRunnerScreenRecording?: { provider?: AppleRunnerScreenRecordingTransport };
};

type RequestPlatformProviderScopeWrapper = <T>(task: () => Promise<T>) => Promise<T>;

type RequestPlatformProviderDescriptor = {
  resolverKey: keyof PlatformProviderResolvers;
  resolve: (
    providers: PlatformProviderResolvers,
    context: PlatformProviderRequestContext,
  ) => ResolvedRequestPlatformProviders;
  appendWrapper: (
    scopedProviders: ResolvedRequestPlatformProviders,
    wrappers: RequestPlatformProviderScopeWrapper[],
    web?: WebPlatformSelection,
  ) => Promise<void>;
};

/**
 * Root-owned provider composition. Device selection is intentionally absent: the daemon resolves
 * the provider device first and supplies only this neutral context. Concrete providers are loaded
 * lazily at the moment their request scope is actually needed.
 */
export function createComposedRequestPlatformProviders(
  options: RequestPlatformProviderOptions = {},
): RequestPlatformProviders {
  const providers = options.providers ?? {};
  const hasConfiguredResolvers = hasPlatformProviderResolvers(providers);
  return Object.freeze({
    hasConfiguredResolvers,
    run: async <T>(
      context: PlatformProviderRequestContext,
      task: (scope: RequestPlatformProviderScope) => Promise<T>,
    ): Promise<T> => {
      const effectiveProviders = await providersForContext(providers, options.web, context);
      const scopedProviders = resolveRequestPlatformProviders(effectiveProviders, context);
      const scope: RequestPlatformProviderScope = {
        androidAdbExecutor: scopedProviders.androidAdb?.executor,
      };
      const wrappers = await requestPlatformProviderScopeWrappers(scopedProviders, options.web);
      return await runRequestPlatformProviderScopes(wrappers, async () => await task(scope));
    },
  });
}

async function providersForContext(
  providers: PlatformProviderResolvers,
  web: WebPlatformSelection | undefined,
  context: PlatformProviderRequestContext,
): Promise<PlatformProviderResolvers> {
  const session = webBackendKeyOf(context.device.id);
  if (context.device.platform !== 'web' || !web) return providers;
  const platform = web.get();
  if (providers.webProvider || !context.useDefaultWebProvider || session === undefined)
    return providers;
  const defaultProvider = await platform.operations.createProvider(session);
  return {
    ...providers,
    webProvider: () => defaultProvider,
  };
}

const REQUEST_PLATFORM_PROVIDER_DESCRIPTORS = [
  {
    resolverKey: 'androidAdbProvider',
    resolve(providers, context) {
      const resolver = providers.androidAdbProvider;
      if (!resolver || !platformGatedResolverApplies('androidAdbProvider', context.device))
        return {};
      const provider = resolver(context);
      const executor = typeof provider === 'function' ? provider : provider?.exec;
      return { androidAdb: { provider, executor, serial: context.device.id } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.androidAdb?.provider) return;
      const { withAndroidAdbProvider } = await loadAndroidMechanics();
      appendRequestProviderWrapper(wrappers, scopedProviders.androidAdb, (provider, task) =>
        withAndroidAdbProvider(
          provider,
          { serial: scopedProviders.androidAdb?.serial ?? '' },
          task,
        ),
      );
    },
  },
  {
    resolverKey: 'appleRunnerProvider',
    resolve(providers, context) {
      const resolver = providers.appleRunnerProvider;
      if (!resolver || !platformGatedResolverApplies('appleRunnerProvider', context.device))
        return {};
      const provider = resolver(context);
      return {
        appleRunner: {
          provider,
          deviceId: context.device.id,
          requestId: context.requestId,
        },
      };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.appleRunner?.provider) return;
      const { withAppleRunnerProvider } = await import('@agent-device/apple-runner');
      const resolved = scopedProviders.appleRunner;
      wrappers.push(
        async (task) =>
          await withAppleRunnerProvider(
            resolved.provider,
            {
              deviceId: resolved.deviceId ?? '',
              requestId: resolved.requestId,
            },
            task,
          ),
      );
    },
  },
  {
    resolverKey: 'appleToolProvider',
    resolve(providers, context) {
      const resolver = providers.appleToolProvider;
      if (!resolver || !platformGatedResolverApplies('appleToolProvider', context.device))
        return {};
      return { appleTool: { provider: resolver(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.appleTool?.provider) return;
      const { withAppleToolProvider } = await import('@agent-device/platform-apple/tool-provider');
      appendRequestProviderWrapper(wrappers, scopedProviders.appleTool, withAppleToolProvider);
    },
  },
  {
    resolverKey: 'vegaToolProvider',
    resolve(providers, context) {
      const resolver = providers.vegaToolProvider;
      if (!resolver || !platformGatedResolverApplies('vegaToolProvider', context.device)) return {};
      return { vegaTool: { provider: resolver(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.vegaTool?.provider) return;
      const { withVegaToolProvider } = await import('@agent-device/platform-vega');
      appendRequestProviderWrapper(wrappers, scopedProviders.vegaTool, withVegaToolProvider);
    },
  },
  {
    resolverKey: 'linuxToolProvider',
    resolve(providers, context) {
      const resolver = providers.linuxToolProvider;
      if (!resolver || !platformGatedResolverApplies('linuxToolProvider', context.device))
        return {};
      return { linuxTool: { provider: resolver(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.linuxTool?.provider) return;
      const { withLinuxToolProvider } = await import('@agent-device/platform-linux');
      appendRequestProviderWrapper(wrappers, scopedProviders.linuxTool, withLinuxToolProvider);
    },
  },
  {
    resolverKey: 'webProvider',
    resolve(providers, context) {
      const resolver = providers.webProvider;
      if (!resolver || context.device.platform !== 'web') return {};
      return { web: { provider: resolver(context) } };
    },
    async appendWrapper(scopedProviders, wrappers, web) {
      if (!scopedProviders.web?.provider || !web) return;
      appendRequestProviderWrapper(wrappers, scopedProviders.web, web.get().withRequestProvider);
    },
  },
  {
    resolverKey: 'appleRunnerScreenRecordingTransport',
    resolve(providers, context) {
      const resolver = providers.appleRunnerScreenRecordingTransport;
      if (!resolver) return {};
      return { appleRunnerScreenRecording: { provider: resolver(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      const runner = scopedProviders.appleRunnerScreenRecording?.provider;
      if (!runner && !scopedProviders.appleRunner?.provider) return;
      const { withAppleRunnerScreenRecordingTransport } =
        await import('../platform-runtime-screen-recording-apple-runner-transport.ts');
      wrappers.push(async (task) => await withAppleRunnerScreenRecordingTransport(runner, task));
    },
  },
  {
    resolverKey: 'appleSimulatorScreenRecordingTransport',
    resolve(providers, context) {
      const resolver = providers.appleSimulatorScreenRecordingTransport;
      if (!resolver) return {};
      return { appleSimulatorScreenRecording: { provider: resolver(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      const simulator = scopedProviders.appleSimulatorScreenRecording?.provider;
      if (!simulator && !scopedProviders.appleRunner?.provider) return;
      const { withAppleSimulatorScreenRecordingTransport } =
        await import('../platform-runtime-screen-recording-apple-transport.ts');
      wrappers.push(
        async (task) => await withAppleSimulatorScreenRecordingTransport(simulator, task),
      );
    },
  },
] satisfies RequestPlatformProviderDescriptor[];

function resolveRequestPlatformProviders(
  providers: PlatformProviderResolvers,
  context: PlatformProviderRequestContext,
): ResolvedRequestPlatformProviders {
  return REQUEST_PLATFORM_PROVIDER_DESCRIPTORS.reduce<ResolvedRequestPlatformProviders>(
    (resolved, descriptor) => ({ ...resolved, ...descriptor.resolve(providers, context) }),
    {},
  );
}

function hasPlatformProviderResolvers(providers: PlatformProviderResolvers): boolean {
  return REQUEST_PLATFORM_PROVIDER_DESCRIPTORS.some((descriptor) =>
    Boolean(providers[descriptor.resolverKey]),
  );
}

function platformGatedResolverApplies(
  key: PlatformGatedProviderResolverKey,
  device: DeviceInfo,
): boolean {
  // A predicate, never a throw: an absent optional family gates no resolver, and the runtime or
  // interactor lookup the same request then performs raises the typed plugin-not-installed outcome.
  // The registry is intentionally loaded by the root composition, not by the daemon request path.
  return (
    builtinPlatformPlugins
      .tryGet(device.platform)
      ?.plugin.providers?.platformGatedResolvers.includes(key) ?? false
  );
}

async function requestPlatformProviderScopeWrappers(
  scopedProviders: ResolvedRequestPlatformProviders,
  web?: WebPlatformSelection,
): Promise<RequestPlatformProviderScopeWrapper[]> {
  const wrappers: RequestPlatformProviderScopeWrapper[] = [];
  for (const descriptor of REQUEST_PLATFORM_PROVIDER_DESCRIPTORS) {
    await descriptor.appendWrapper(scopedProviders, wrappers, web);
  }
  return wrappers;
}

function appendRequestProviderWrapper<TProvider>(
  wrappers: RequestPlatformProviderScopeWrapper[],
  resolved: { provider?: TProvider } | undefined,
  withProvider: <T>(provider: TProvider, task: () => Promise<T>) => Promise<T>,
): void {
  const provider = resolved?.provider;
  if (!provider) return;
  wrappers.push(async (task) => await withProvider(provider, task));
}

async function runRequestPlatformProviderScopes<T>(
  wrappers: RequestPlatformProviderScopeWrapper[],
  task: () => Promise<T>,
): Promise<T> {
  let run = task;
  for (const wrapper of [...wrappers].reverse()) {
    const next = run;
    run = async () => await wrapper(next);
  }
  return await run();
}
