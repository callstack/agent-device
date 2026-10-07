import type { DefaultCloudWebDriverProviderRuntimeEnv } from '@agent-device/provider-webdriver';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { LIMRUN_PROVIDER } from '@agent-device/provider-limrun';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRuntimeProviderRegistration } from './platform-runtime-gateway.ts';
import { asAppError, type AppError } from '@agent-device/kernel/errors';
import { providerWebDriver } from './provider-webdriver.ts';
import { readLimrunCredentials, type LimrunCredentials } from './provider-limrun-credentials.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export const DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS = [
  ...providerWebDriver.providerIds,
  'limrun' satisfies typeof LIMRUN_PROVIDER,
] as const;

export type DefaultProviderRuntimeComposition = Readonly<{
  runtimes: readonly ProviderDeviceRuntime[];
  platformModules: readonly PlatformRuntimeProviderRegistration[];
  /** Providers left out because their environment configuration is invalid; the rest still load. */
  skipped?: readonly Readonly<{ provider: string; error: AppError }>[];
}>;

/**
 * Extracts eager provider-owner metadata without loading a provider implementation. Both the
 * daemon composition and integration harnesses use this one classification so a provider-owned
 * device can never silently select a local lifecycle runtime merely because its registration was
 * forgotten at a call site.
 */
export function createProviderPlatformRuntimeRegistrations(
  runtimes: readonly ProviderDeviceRuntime[],
): readonly PlatformRuntimeProviderRegistration[] {
  return Object.freeze(
    runtimes.flatMap((runtime) =>
      hasPlatformRuntimeModule(runtime)
        ? [{ runtime, module: providerPlatformRuntimeModule(runtime) }]
        : [],
    ),
  );
}

export async function createDaemonProviderRuntimeComposition(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<DefaultProviderRuntimeComposition> {
  const bundled = await createDefaultProviderRuntimeComposition(env);
  try {
    const [{ loadProviderPlugins }, { RESERVED_PLUGIN_PROVIDERS }] = await Promise.all([
      import('./plugins/load.ts'),
      import('./plugins/manifest.ts'),
    ]);
    const plugins = await loadProviderPlugins(env, RESERVED_PLUGIN_PROVIDERS);
    return Object.freeze({
      ...bundled,
      runtimes: Object.freeze([...bundled.runtimes, ...plugins.map(({ runtime }) => runtime)]),
      platformModules: Object.freeze([
        ...bundled.platformModules,
        ...plugins.map(({ runtime, platformModule }) => ({ runtime, module: platformModule })),
      ]),
    });
  } catch (error) {
    await Promise.allSettled(bundled.runtimes.map(async (runtime) => await runtime.shutdown()));
    throw error;
  }
}

export async function createDefaultProviderRuntimeComposition(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<DefaultProviderRuntimeComposition> {
  const runtimes = providerWebDriver.createDefaultRuntimes(env);
  const platformModules = [...createProviderPlatformRuntimeRegistrations(runtimes)];
  let limrunCredentials: LimrunCredentials | undefined;
  try {
    limrunCredentials = readLimrunCredentials(env);
  } catch (error) {
    return Object.freeze({
      runtimes,
      platformModules: Object.freeze(platformModules),
      skipped: [{ provider: 'limrun', error: asAppError(error) }],
    });
  }
  if (!limrunCredentials) {
    return Object.freeze({ runtimes, platformModules: Object.freeze(platformModules) });
  }

  const [limrunRuntime, dependencies] = await Promise.all([
    import('@agent-device/provider-limrun'),
    import('./sdk/limrun-runtime-dependencies.ts'),
  ]);
  const registration = limrunRuntime.createLimrunRuntime(
    limrunCredentials,
    dependencies.createLimrunRuntimeDependencies(),
    { includePlatformModule: true },
  );
  return Object.freeze({
    runtimes: Object.freeze([...runtimes, registration.runtime]),
    platformModules: Object.freeze([
      ...platformModules,
      { runtime: registration.runtime, module: registration.platformModule },
    ]),
  });
}

type ProviderRuntimeWithPlatformModule = ProviderDeviceRuntime &
  Readonly<{
    owner: PlatformRuntimeProviderModule['owner'];
    loadRuntime(host: PlatformRuntimeHost): Promise<PlatformRuntimeOwner>;
  }>;

function hasPlatformRuntimeModule(
  runtime: ProviderDeviceRuntime,
): runtime is ProviderRuntimeWithPlatformModule {
  if (!('owner' in runtime) || !('loadRuntime' in runtime)) return false;
  const owner = runtime.owner;
  return (
    typeof runtime.loadRuntime === 'function' &&
    isProviderRuntimeOwner(owner) &&
    owner.provider === runtime.provider
  );
}

function isProviderRuntimeOwner(owner: unknown): owner is PlatformRuntimeProviderModule['owner'] {
  return (
    typeof owner === 'object' &&
    owner !== null &&
    'kind' in owner &&
    owner.kind === 'provider-runtime' &&
    'provider' in owner &&
    typeof owner.provider === 'string' &&
    'instance' in owner &&
    typeof owner.instance === 'string'
  );
}

function providerPlatformRuntimeModule(
  runtime: ProviderRuntimeWithPlatformModule,
): PlatformRuntimeProviderModule {
  return Object.freeze({
    owner: runtime.owner,
    loadRuntime: async (host) => await runtime.loadRuntime(host),
  });
}
