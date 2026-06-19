import { resolveTargetDevice } from '../core/dispatch-resolve.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../platforms/android/adb-executor.ts';
import type {
  AppleRunnerCommandExecutor,
  AppleRunnerProvider,
} from '../platforms/ios/runner-provider.ts';
import type {
  AppleToolCommandExecutor,
  AppleToolProvider,
} from '../platforms/ios/tool-provider.ts';
import type { LinuxToolProvider } from '../platforms/linux/tool-provider.ts';
import type { WebProvider } from '../platforms/web/provider.ts';
import { isApplePlatform, type DeviceInfo } from '../utils/device.ts';
import type { AppLogProvider } from './app-log.ts';
import { hasExplicitDeviceSelector } from './device-selector-intent.ts';
import type { RecordingProvider } from './recording-provider.ts';
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

export type AppleToolProviderResolver = PlatformProviderResolver<
  AppleToolProvider | AppleToolCommandExecutor | undefined
>;

export type LinuxToolProviderResolver = PlatformProviderResolver<LinuxToolProvider | undefined>;

export type WebProviderResolver = PlatformProviderResolver<WebProvider | undefined>;

export type AppLogProviderResolver = PlatformProviderResolver<AppLogProvider | undefined>;

export type RecordingProviderResolver = PlatformProviderResolver<RecordingProvider | undefined>;

export type PlatformProviderResolvers = {
  androidAdbProvider?: AndroidAdbProviderResolver;
  appleRunnerProvider?: AppleRunnerProviderResolver;
  appleToolProvider?: AppleToolProviderResolver;
  linuxToolProvider?: LinuxToolProviderResolver;
  webProvider?: WebProviderResolver;
  appLogProvider?: AppLogProviderResolver;
  recordingProvider?: RecordingProviderResolver;
};

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
    provider?: AppleToolProvider | AppleToolCommandExecutor;
  };
  linuxTool?: {
    provider?: LinuxToolProvider;
  };
  web?: {
    provider?: WebProvider;
  };
  appLog?: {
    provider?: AppLogProvider;
  };
  recording?: {
    provider?: RecordingProvider;
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
      if (!androidAdbProvider || context.device.platform !== 'android') return {};
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
      if (!appleRunnerProvider || !isApplePlatform(context.device.platform)) return {};
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
      const { withAppleRunnerProvider } = await import('../platforms/ios/runner-provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.appleRunner, (provider, task) =>
        withAppleRunnerProvider(
          provider,
          {
            deviceId: scopedProviders.appleRunner?.deviceId ?? '',
            requestId: scopedProviders.appleRunner?.requestId,
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
      if (!appleToolProvider || !isApplePlatform(context.device.platform)) return {};
      return { appleTool: { provider: appleToolProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.appleTool?.provider) return;
      const { withAppleToolProvider } = await import('../platforms/ios/tool-provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.appleTool, withAppleToolProvider);
    },
  },
  {
    resolverKey: 'linuxToolProvider',
    resolve(providers, context) {
      const linuxToolProvider = providers.linuxToolProvider;
      if (!linuxToolProvider || context.device.platform !== 'linux') return {};
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
      if (!webProvider || context.device.platform !== 'web') return {};
      return { web: { provider: webProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.web?.provider) return;
      const { withWebProvider } = await import('../platforms/web/provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.web, withWebProvider);
    },
  },
  {
    resolverKey: 'appLogProvider',
    resolve(providers, context) {
      const appLogProvider = providers.appLogProvider;
      if (!appLogProvider) return {};
      return { appLog: { provider: appLogProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.appLog?.provider) return;
      const { withAppLogProvider } = await import('./app-log.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.appLog, withAppLogProvider);
    },
  },
  {
    resolverKey: 'recordingProvider',
    resolve(providers, context) {
      const recordingProvider = providers.recordingProvider;
      if (!recordingProvider) return {};
      return { recording: { provider: recordingProvider(context) } };
    },
    async appendWrapper(scopedProviders, wrappers) {
      if (!scopedProviders.recording?.provider) return;
      const { withRecordingProvider } = await import('./recording-provider.ts');
      appendRequestProviderWrapper(wrappers, scopedProviders.recording, withRecordingProvider);
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
    hasExplicitDeviceSelector: hasExplicitDeviceSelector(req.flags),
  });
  switch (intent) {
    case 'existing-session':
      return existingSession?.device;
    case 'explicit-device':
    case 'sessionless-default-device':
      return await resolveTargetDevice(req.flags ?? {});
    case 'skip':
      return undefined;
  }
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
