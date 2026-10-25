// Collects the capability matrix by asking the real runtimes.
//
// Each column is one device shape (see targets.ts). For each one this module
// loads the owning platform runtime against the stub host, gives a cloud column
// its provider session first, calls the same `inspectFacts(device)` the
// `capabilities` command answers from, and keeps the public commands whose
// required runtime operations are all available. The command list and the
// command-to-operation requirements both come from the command registry, so the
// matrix cannot claim a command the registry does not expose.

import { listRuntimeFactCommands } from '@agent-device/command-registry/registry';
import { commandIsAvailableFromFacts } from '@agent-device/command-registry/planned-operations';
import { runtimeModule as appleRuntimeModule } from '@agent-device/platform-apple';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import { runtimeModule as webRuntimeModule } from '@agent-device/platform-web';
import { runtimeModule as vegaRuntimeModule } from '@agent-device/platform-vega';
import { runtimeModule as harmonyosRuntimeModule } from '@agent-device/platform-harmonyos';
import { runtimeModule as linuxRuntimeModule } from '@agent-device/platform-linux';
import { BUNDLED_CLOUD_WEBDRIVER_PROVIDERS } from '@agent-device/provider-webdriver';
import { createCloudWebDriverRuntime } from '@agent-device/provider-webdriver/plugin';
import { CLOUD_WEBDRIVER_PROVIDERS } from '@agent-device/provider-webdriver/providers';
import type { RunHostCommand } from '@agent-device/provider-webdriver';
import testmuPlugin from '@agent-device/testmu';
import type { DeviceLease } from '@agent-device/contracts/device';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createProviderWire, PROVIDER_ENV, stubLimrunSdk, type ProviderWire } from './seams.ts';
import { TARGETS, type Target } from './targets.ts';

export type CommandSupport = Readonly<{
  /** Public commands the registry derives from runtime facts, in registry order. */
  commands: readonly string[];
  /** Command set per target id. */
  support: ReadonlyMap<string, ReadonlySet<string>>;
  /** Available runtime operations per target id, the finer read the qualified cells use. */
  operations: ReadonlyMap<string, ReadonlySet<string>>;
}>;

type LocalRuntimeKey = 'apple' | 'android' | 'web' | 'vega' | 'harmonyos' | 'linux';

function localRuntimeKey(device: DeviceInfo): LocalRuntimeKey {
  switch (device.platform) {
    case 'apple':
      return 'apple';
    case 'android':
      return 'android';
    case 'web':
      return 'web';
    case 'vega':
      return 'vega';
    case 'harmonyos':
      return 'harmonyos';
    default:
      return 'linux';
  }
}

/**
 * The public commands a device can run: a command is supported when at least one
 * of its declared operation sets is fully available on that device. This is the
 * same rule the daemon's `capabilities` inventory applies to its facts.
 */
function supportedCommands(
  facts: Awaited<ReturnType<PlatformRuntimeOwner['inspectFacts']>>,
  commands: readonly string[],
): Set<string> {
  // The same rule the daemon's `capabilities` inventory applies, owned by the
  // registry package, so the page and the command cannot disagree.
  const supported = new Set<string>();
  for (const command of commands) {
    if (commandIsAvailableFromFacts(command, facts)) supported.add(command);
  }
  return supported;
}

/** Operations the device's facts mark available, the per-operation read operation rows use. */
function availableOperations(
  facts: Awaited<ReturnType<PlatformRuntimeOwner['inspectFacts']>>,
): Set<string> {
  const available = new Set<string>();
  for (const [operation, fact] of Object.entries(facts.operations)) {
    if (fact?.available === true) available.add(operation);
  }
  return available;
}

type TargetFacts = Readonly<{ commands: Set<string>; operations: Set<string> }>;

function targetFacts(
  facts: Awaited<ReturnType<PlatformRuntimeOwner['inspectFacts']>>,
  commands: readonly string[],
): TargetFacts {
  return { commands: supportedCommands(facts, commands), operations: availableOperations(facts) };
}

type LocalRuntimes = Readonly<Record<LocalRuntimeKey, PlatformRuntimeOwner>>;

async function loadLocalRuntimes(host: PlatformRuntimeHost): Promise<LocalRuntimes> {
  const android = createAndroidRuntimeModule({ bindAdbHost: async () => undefined });
  const [apple, androidRuntime, web, vega, harmonyos, linux] = await Promise.all([
    appleRuntimeModule.loadRuntime(host),
    android.loadRuntime(host),
    webRuntimeModule.loadRuntime(host),
    vegaRuntimeModule.loadRuntime(host),
    harmonyosRuntimeModule.loadRuntime(host),
    linuxRuntimeModule.loadRuntime(host),
  ]);
  return { apple, android: androidRuntime, web, vega, harmonyos, linux };
}

const CLOUD_WEBDRIVER_PLUGIN_PROVIDERS: Readonly<Record<string, string>> = {
  [CLOUD_WEBDRIVER_PROVIDERS.browserStack]: 'browserstack',
  [CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm]: 'aws-device-farm',
};

/** The provider's WebDriver options, from the bundled registration or the plugin package. */
async function cloudWebDriverOptions(
  plugin: string,
  runHostCommand: RunHostCommand,
): Promise<Record<string, unknown>> {
  if (plugin === 'testmu') {
    // The package's default export is the plugin factory; the WebDriver is what its setup() builds.
    const plugin_ = testmuPlugin();
    if (!plugin_.setup)
      throw new Error('The TestMu plugin exposes no setup() to build a WebDriver from.');
    const created = (await plugin_.setup({
      env: PROVIDER_ENV,
      clientVersion: '0.0.0',
    } as never)) as {
      webDriver: Record<string, unknown>;
    };
    return created.webDriver;
  }
  const providerName = CLOUD_WEBDRIVER_PLUGIN_PROVIDERS[plugin];
  if (!providerName) throw new Error(`Unknown cloud WebDriver plugin "${plugin}".`);
  const registration = BUNDLED_CLOUD_WEBDRIVER_PROVIDERS.find(
    (candidate) => candidate.declaration.provider === providerName,
  );
  if (!registration) {
    throw new Error(`No bundled cloud WebDriver registration for plugin "${plugin}".`);
  }
  const created = await registration.create({
    env: PROVIDER_ENV,
    clientVersion: '0.0.0',
    runHostCommand,
  } as never);
  return created.webDriver as unknown as Record<string, unknown>;
}

function cloudLease(target: Target & { readonly kind: 'cloud-webdriver' }): DeviceLease {
  return {
    leaseId: `lease-${target.id}`,
    leaseProvider: target.provider,
    backend: 'cloud-webdriver',
    platform: target.platform,
    target: 'mobile',
    session: 'session-1',
    workspace: '/workspace',
    runId: 'run-1',
    deviceId: 'provider-device',
  } as unknown as DeviceLease;
}

function limrunLease(target: Target & { readonly kind: 'limrun' }): DeviceLease {
  return {
    leaseId: `lease-${target.platform}`,
    leaseProvider: 'limrun',
    backend: target.backend,
    platform: target.platform,
    target: 'mobile',
    session: 'session-1',
    workspace: '/workspace',
    device: 'limrun',
    runId: 'run-1',
    deviceId: 'provider-device',
  } as unknown as DeviceLease;
}

/**
 * Facts for a hosted column. The provider owns its device record, so the column
 * reads it back from the provider's own inventory after the lease is allocated;
 * a hand-made device would answer for a device that provider never offers.
 */
async function cloudWebDriverSupport(
  target: Target & { readonly kind: 'cloud-webdriver' },
  host: PlatformRuntimeHost,
  wire: ProviderWire,
  commands: readonly string[],
): Promise<TargetFacts> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = wire.fetch;
  try {
    const options = await cloudWebDriverOptions(target.plugin, wire.runHostCommand);
    const runtime = await createCloudWebDriverRuntime({
      ...options,
      clientVersion: '0.0.0',
    } as never);
    const owner = await runtime.platformRuntimeModule.loadRuntime(host);
    const lease = cloudLease(target);
    await runtime.leaseLifecycle.allocate?.(lease, { flags: target.flags } as never);
    const devices = await runtime.deviceInventoryProvider({
      leaseProvider: target.provider,
      leaseId: lease.leaseId,
    } as never);
    const device = devices?.[0];
    if (!device) throw new Error(`Provider "${target.provider}" invented no device for its lease.`);
    return targetFacts(await owner.inspectFacts(device), commands);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function limrunSupport(
  targets: ReadonlyArray<Target & { readonly kind: 'limrun' }>,
  host: PlatformRuntimeHost,
  commands: readonly string[],
): Promise<Map<string, TargetFacts>> {
  // The hooks must be in place before the provider's own `@limrun/api` import resolves.
  stubLimrunSdk();
  const { createLimrunRuntime } = await import('@agent-device/provider-limrun');
  const runtime = createLimrunRuntime(
    {
      instances: {
        ios: { apiUrl: 'https://limrun.invalid.test', token: 'limrun-placeholder-token' },
        android: {
          apiUrl: 'https://limrun.invalid.test',
          adbUrl: 'wss://limrun.invalid.test',
          token: 'limrun-placeholder-token',
        },
      },
    },
    {
      clientVersion: '0.0.0',
      android: { createPortReverse: async () => ({}) },
      host: {},
      ios: {},
    } as never,
    { includePlatformModule: true },
  );
  const owner = await runtime.platformModule.loadRuntime(host);
  const support = new Map<string, TargetFacts>();
  for (const target of targets) {
    await namingTarget(target, async () => {
      // Limrun facts are session-gated: the lease must exist before the runtime answers.
      await runtime.runtime.leaseLifecycle.allocate?.(limrunLease(target), { flags: {} } as never);
      support.set(target.id, targetFacts(await owner.inspectFacts(target.device), commands));
    });
  }
  return support;
}

/** Re-raises a fact-collection failure with the column whose collection produced it. */
async function namingTarget(target: Target, collect: () => Promise<void>): Promise<void> {
  try {
    await collect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Capability facts failed for target "${target.id}" (${target.label}): ${reason}`,
    );
  }
}

export async function collectCommandSupport(host: PlatformRuntimeHost): Promise<CommandSupport> {
  const commands = listRuntimeFactCommands();
  const support = new Map<string, ReadonlySet<string>>();
  const operations = new Map<string, ReadonlySet<string>>();
  const record = (id: string, facts: TargetFacts) => {
    support.set(id, facts.commands);
    operations.set(id, facts.operations);
  };
  const locals = await loadLocalRuntimes(host);

  for (const target of TARGETS) {
    if (target.kind !== 'local') continue;
    const owner = locals[localRuntimeKey(target.device)];
    await namingTarget(target, async () => {
      record(target.id, targetFacts(await owner.inspectFacts(target.device), commands));
    });
  }

  const wire = createProviderWire();
  for (const target of TARGETS) {
    if (target.kind !== 'cloud-webdriver') continue;
    await namingTarget(target, async () => {
      record(target.id, await cloudWebDriverSupport(target, host, wire, commands));
    });
  }

  const limrunTargets = TARGETS.filter(
    (target): target is Target & { readonly kind: 'limrun' } => target.kind === 'limrun',
  );
  for (const [id, facts] of await limrunSupport(limrunTargets, host, commands)) {
    record(id, facts);
  }

  return { commands, support, operations };
}
