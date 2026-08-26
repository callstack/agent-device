import type { PlatformGatedProviderResolverKey } from '@agent-device/contracts/platform-providers';
import { resolveTargetDevice } from '../core/dispatch-resolve.ts';
import { registerBuiltinPlatformPlugins } from '../core/interactors/register-builtins.ts';
import { tryGetPlugin } from '../core/platform-plugin-registry.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../platforms/android/adb-executor.ts';
import type {
  AppleRunnerCommandExecutor,
  AppleRunnerProvider,
} from '../platforms/apple/core/runner/runner-provider.ts';
import type { AppleToolProvider } from '../platforms/apple/core/tool-provider.ts';
import type { LinuxToolProvider } from '../platforms/linux/tool-provider.ts';
import type { VegaToolProvider } from '../platforms/vega/tool-provider.ts';
import { withWebProvider, type WebProvider } from '../platforms/web/provider.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleSimulatorScreenRecordingTransport } from '../platform-runtime-screen-recording-apple-transport.ts';
import type { AppleRunnerScreenRecordingTransport } from '../platform-runtime-screen-recording-apple-runner-transport.ts';
import { hasDeviceSelectionInput, hasExplicitDeviceSelector } from './device-selector-intent.ts';
import { buildOpenTargetDeviceResolutionOptions } from './open-device-selection.ts';
import type { DaemonRequest, SessionState } from './types.ts';
import { resolveProviderDeviceResolutionIntent } from './daemon-command-registry.ts';

export type PlatformProviderRequestSession = Pick<
  SessionState,
  'name' | 'device' | 'appBundleId' | 'appName' | 'surface'
>;

export type PlatformProviderResolver<TResult> = (
  params: RequestPlatformProviderResolverContext,
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

// Compile-time: every gated key is a real resolver key (so the facet can never name a
// resolver the daemon does not compose).
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` keeps the guard alive. */
export type GatedKeysAreResolverKeys = AssertTrue<
  [PlatformGatedProviderResolverKey] extends [keyof PlatformProviderResolvers] ? true : false
>;

// The plugin registry backs `platformGatedResolverApplies`; register the builtin
// plugins on load so the lookup is populated (idempotent, mirrors app-log.ts).
registerBuiltinPlatformPlugins();

/**
 * Whether the platform-gated resolver `key` applies to `device`, per the owning
 * family's PlatformPlugin `providers` facet. A device on a platform with no plugin, or
 * a family that does not list `key`, resolves to `false` — byte-identical to the former
 * hand `device.platform === …` gate (which also excluded every other platform). Pinned
 * by the providers-plugin routing parity test.
 */
function platformGatedResolverApplies(
  key: PlatformGatedProviderResolverKey,
  device: DeviceInfo,
): boolean {
  return tryGetPlugin(device.platform)?.providers?.platformGatedResolvers.includes(key) ?? false;
}

export type RequestPlatformProviderScope = {
  androidAdbExecutor?: AndroidAdbExecutor;
};

type RequestPlatformProviderParams = {
  req: DaemonRequest;
  existingSession: SessionState | undefined;
  providers: PlatformProviderResolvers;
};

type RequestPlatformProviderResolverContext = {
  req: DaemonRequest;
  device: DeviceInfo;
  session?: PlatformProviderRequestSession;
};

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
  appleTool?: {
    provider?: AppleToolProvider;
  };
  linuxTool?: {
    provider?: LinuxToolProvider;
  };
  vegaTool?: {
    provider?: VegaToolProvider;
  };
  web?: {
    provider?: WebProvider;
  };
  appleSimulatorScreenRecording?: {
    provider?: AppleSimulatorScreenRecordingTransport;
  };
  appleRunnerScreenRecording?: {
    provider?: AppleRunnerScreenRecordingTransport;
  };
};

type RequestPlatformProviderScopeWrapper = <T>(task: () => Promise<T>) => Promise<T>;

type RequestPlatformProviderDescriptor = {
  resolverKey: keyof PlatformProviderResolvers;
  resolve: (
    providers: PlatformProviderResolvers,
    context: RequestPlatformProviderResolverContext,
  ) => ResolvedRequestPlatformProviders;
  appendWrapper: (
    scopedProviders: ResolvedRequestPlatformProviders,
    wrappers: RequestPlatformProviderScopeWrapper[],
  ) => Promise<void>;
};

const REQUEST_PLATFORM_PROVIDER_DESCRIPTORS = [
  {
    resolverKey: 'androidAdbProvider',
    resolve(providers, context) {
      const androidAdbProvider = providers.androidAdbProvider;
      if (
        !androidAdbProvider ||
        !platformGatedResolverApplies('androidAdbProvider', context.device)
      )
        return {};
      const provider = androidAdbProvider(context);
      const executor = typeof provider === 'function' ? provider : provider?.exec;
      return { androidAdb: { provider, executor, serial: context.device.id } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.androidAdb?.provider) return;
      const { withAndroidAdbProvider } = await import('../platforms/android/adb-executor.ts');
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
      const appleRunnerProvider = providers.appleRunnerProvider;
      if (
        !appleRunnerProvider ||
        !platformGatedResolverApplies('appleRunnerProvider', context.device)
      )
        return {};
      const provider = appleRunnerProvider(context);
      return {
        appleRunner: {
          provider,
          deviceId: context.device.id,
          requestId: context.req.meta?.requestId,
        },
      };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.appleRunner?.provider) return;
      const { withAppleRunnerProvider } =
        await import('../platforms/apple/core/runner/runner-provider.ts');
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
      const appleToolProvider = providers.appleToolProvider;
      if (!appleToolProvider || !platformGatedResolverApplies('appleToolProvider', context.device))
        return {};
      return { appleTool: { provider: appleToolProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.appleTool?.provider) return;
      const { withAppleToolProvider } = await import('../platforms/apple/core/tool-provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.appleTool, withAppleToolProvider);
    },
  },
  {
    resolverKey: 'vegaToolProvider',
    resolve(providers, context) {
      const vegaToolProvider = providers.vegaToolProvider;
      if (!vegaToolProvider || !platformGatedResolverApplies('vegaToolProvider', context.device))
        return {};
      return { vegaTool: { provider: vegaToolProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.vegaTool?.provider) return;
      const { withVegaToolProvider } = await import('../platforms/vega/tool-provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.vegaTool, withVegaToolProvider);
    },
  },
  {
    resolverKey: 'linuxToolProvider',
    resolve(providers, context) {
      const linuxToolProvider = providers.linuxToolProvider;
      if (!linuxToolProvider || !platformGatedResolverApplies('linuxToolProvider', context.device))
        return {};
      return { linuxTool: { provider: linuxToolProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.linuxTool?.provider) return;
      const { withLinuxToolProvider } = await import('../platforms/linux/tool-provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.linuxTool, withLinuxToolProvider);
    },
  },
  {
    resolverKey: 'webProvider',
    resolve(providers, context) {
      const webProvider = providers.webProvider;
      if (!webProvider || !platformGatedResolverApplies('webProvider', context.device)) return {};
      return { web: { provider: webProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.web?.provider) return;
      appendRequestProviderWrapper(wrappers, scopedProviders.web, withWebProvider);
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

export async function withRequestPlatformProviderScope<T>(
  params: RequestPlatformProviderParams,
  task: (scope: RequestPlatformProviderScope) => Promise<T>,
): Promise<T> {
  const scopedProviders = await resolveRequestPlatformProviders(params);
  const scope: RequestPlatformProviderScope = {
    androidAdbExecutor: scopedProviders.androidAdb?.executor,
  };
  const wrappers = await requestPlatformProviderScopeWrappers(scopedProviders);

  return await runRequestPlatformProviderScopes(wrappers, async () => await task(scope));
}

async function resolveRequestPlatformProviders(
  params: RequestPlatformProviderParams,
): Promise<ResolvedRequestPlatformProviders> {
  if (!hasPlatformProviderResolvers(params.providers)) return {};
  const device = await resolveScopedProviderDevice(params.req, params.existingSession);
  if (!device) return {};
  const context = requestProviderResolverContext(params, device);
  return REQUEST_PLATFORM_PROVIDER_DESCRIPTORS.reduce<ResolvedRequestPlatformProviders>(
    (resolved, descriptor) => ({
      ...resolved,
      ...descriptor.resolve(params.providers, context),
    }),
    {},
  );
}

function hasPlatformProviderResolvers(providers: PlatformProviderResolvers): boolean {
  return REQUEST_PLATFORM_PROVIDER_DESCRIPTORS.some((descriptor) =>
    Boolean(providers[descriptor.resolverKey]),
  );
}

function requestProviderResolverContext(
  params: RequestPlatformProviderParams,
  device: DeviceInfo,
): RequestPlatformProviderResolverContext {
  return {
    req: params.req,
    device,
    session: params.existingSession,
  };
}

async function resolveScopedProviderDevice(
  req: DaemonRequest,
  existingSession: SessionState | undefined,
): Promise<DeviceInfo | undefined> {
  const intent = resolveProviderDeviceResolutionIntent(req, {
    hasExistingSession: Boolean(existingSession),
    hasExplicitDeviceIdentity: hasExplicitDeviceSelector(req.flags),
    hasDeviceSelectionInput: hasDeviceSelectionInput(req.flags),
  });
  switch (intent) {
    case 'existing-session':
      return existingSession?.device;
    case 'explicit-device':
    case 'sessionless-default-device':
      // Provider-scope plumbing only: an unresolvable device means "no provider
      // scope for this request", never a failed request — the command's own
      // device resolution still reports its errors downstream.
      try {
        return await resolveProviderTargetDevice(req);
      } catch {
        return undefined;
      }
    case 'skip':
      return undefined;
  }
}

async function resolveProviderTargetDevice(req: DaemonRequest): Promise<DeviceInfo> {
  const options =
    req.command === 'open'
      ? buildOpenTargetDeviceResolutionOptions(req.positionals?.[0])
      : undefined;
  return await resolveTargetDevice(req.flags ?? {}, options);
}

async function requestPlatformProviderScopeWrappers(
  scopedProviders: ResolvedRequestPlatformProviders,
): Promise<RequestPlatformProviderScopeWrapper[]> {
  const wrappers: RequestPlatformProviderScopeWrapper[] = [];
  for (const descriptor of REQUEST_PLATFORM_PROVIDER_DESCRIPTORS) {
    await descriptor.appendWrapper(scopedProviders, wrappers);
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
