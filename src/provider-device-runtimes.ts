import type { DefaultCloudWebDriverProviderRuntimeEnv } from '@agent-device/provider-webdriver';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { DOUBLESPEED_PROVIDER } from '@agent-device/provider-doublespeed';
import type { LIMRUN_PROVIDER } from '@agent-device/provider-limrun';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRuntimeProviderRegistration } from './platform-runtime-gateway.ts';
import { providerWebDriver } from './provider-webdriver.ts';

export type DefaultProviderDeviceRuntimeEnv = DefaultCloudWebDriverProviderRuntimeEnv &
  NodeJS.ProcessEnv;

export const DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS = [
  ...providerWebDriver.providerIds,
  'limrun' satisfies typeof LIMRUN_PROVIDER,
  'doublespeed' satisfies typeof DOUBLESPEED_PROVIDER,
] as const;

export type DefaultProviderRuntimeComposition = Readonly<{
  runtimes: readonly ProviderDeviceRuntime[];
  platformModules: readonly PlatformRuntimeProviderRegistration[];
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

export async function createDefaultProviderRuntimeComposition(
  env: DefaultProviderDeviceRuntimeEnv = process.env,
): Promise<DefaultProviderRuntimeComposition> {
  const runtimes = providerWebDriver.createDefaultRuntimes(env);
  const platformModules = [...createProviderPlatformRuntimeRegistrations(runtimes)];
  const registrations = [
    ...(await loadLimrunRegistration(env)),
    ...(await loadDoublespeedRegistration(env)),
  ];
  return Object.freeze({
    runtimes: Object.freeze([...runtimes, ...registrations.map(({ runtime }) => runtime)]),
    platformModules: Object.freeze([
      ...platformModules,
      ...registrations.map(({ runtime, platformModule }) => ({ runtime, module: platformModule })),
    ]),
  });
}

type ProviderRegistration = Readonly<{
  runtime: ProviderDeviceRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

async function loadLimrunRegistration(
  env: DefaultProviderDeviceRuntimeEnv,
): Promise<readonly ProviderRegistration[]> {
  const apiKey = env.LIMRUN_API_KEY?.trim();
  if (!apiKey) return [];
  const [limrunRuntime, dependencies] = await Promise.all([
    import('@agent-device/provider-limrun'),
    import('./sdk/limrun-runtime-dependencies.ts'),
  ]);
  return [
    limrunRuntime.createLimrunRuntime(
      {
        apiKey,
        region: env.LIMRUN_REGION?.trim() || undefined,
      },
      dependencies.createLimrunRuntimeDependencies(),
      { includePlatformModule: true },
    ),
  ];
}

async function loadDoublespeedRegistration(
  env: DefaultProviderDeviceRuntimeEnv,
): Promise<readonly ProviderRegistration[]> {
  const apiKey = env.DOUBLESPEED_API_KEY?.trim();
  if (!apiKey) return [];
  const doublespeedRuntime = await import('@agent-device/provider-doublespeed');
  const dependencies = await import('./provider-doublespeed-dependencies.ts');
  return [
    doublespeedRuntime.createDoublespeedRuntime(
      {
        apiKey,
        apiUrl: env.DOUBLESPEED_API_URL?.trim() || undefined,
        device: env.DOUBLESPEED_DEVICE?.trim() || undefined,
      },
      dependencies.createDoublespeedRuntimeDependencies(),
      { includePlatformModule: true },
    ),
  ];
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
