import type { PlatformProviderRequestContext } from '@agent-device/contracts/platform-providers';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo, Platform } from '@agent-device/kernel/device';
import type { PlatformPluginAbsence } from './platform-plugin-registry.ts';

// Simulates a composition whose builtin plugins do not include the extracted `vega` family: the
// module-level composition inside request-providers must then register only the remaining
// builtins, leaving `vega` absent from the platform-plugin registry.
vi.mock('./interactors/builtin-platform-plugin-set.ts', async () => {
  const { BUILTIN_PLATFORM_PLUGINS } = await import('./interactors/register-builtins.ts');
  const { registerPlatformPluginSet } = await import('./platform-plugin-registry.ts');
  const { missingPlatformPlugin } = await import('./platform-plugin-absence.ts');
  return {
    builtinPlatformPlugins: registerPlatformPluginSet(
      BUILTIN_PLATFORM_PLUGINS.filter((plugin) => plugin.id !== 'vega'),
      missingPlatformPlugin,
    ),
  };
});

function pluginOwning(id: string, platforms: readonly Platform[]): PlatformPlugin {
  return {
    id,
    platforms,
    createInteractor: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', `${id} interactor must not run`);
    },
  };
}

test('the request-provider scope for an absent optional family gates nothing, lets the task run, and getPlugin answers with the typed outcome', async () => {
  // The private request-provider composition submodule is reached only through the root
  // composition wrapper (R13), exactly as the daemon request path does. A provider-owned device
  // of an absent family must still reach its provider interactor, so the scope does not fail.
  // Composing the set is also what installs this process's absence reporter, so the same scenario
  // checks how the interactor lookup answers for the absent family: a separate test would pass
  // only when this one happened to run first in the file.
  const { createRequestPlatformProviders } = await import('../platform-runtime.ts');
  const vegaDevice: DeviceInfo = {
    platform: 'vega',
    id: 'vega-tv-1',
    name: 'Vega TV',
    kind: 'device',
    target: 'tv',
  };
  const context: PlatformProviderRequestContext = {
    device: vegaDevice,
    session: { name: 'vega-session', device: vegaDevice },
    requestedSession: 'vega-session',
    requestId: 'req-vega-1',
  };
  let resolverAsked = false;
  const providers = createRequestPlatformProviders({
    providers: {
      vegaToolProvider: () => {
        resolverAsked = true;
        return undefined;
      },
    },
  });

  let taskRan = false;
  await providers.run(context, async () => {
    taskRan = true;
  });

  assert.equal(taskRan, true);
  // The vega-gated resolver does not apply while no vega plugin is registered.
  assert.equal(resolverAsked, false);

  // The interactor lookup answers presence through the same outcome the module registry raises
  // (#4781 review): the reporter is the one the composed set was given, so a caller of `getPlugin`
  // needs no guard of its own.
  const { builtinPlatformPlugins } = await import('./interactors/builtin-platform-plugin-set.ts');
  assert.throws(
    () => builtinPlatformPlugins.get('vega'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_PLATFORM' &&
      error.details?.reason === 'plugin-not-installed' &&
      error.details.family === 'vega' &&
      error.details.package === '@agent-device/vega' &&
      typeof error.details.installCommand === 'string' &&
      String(error.details.hint).includes(error.details.installCommand),
  );
});

test('a duplicate plugin set is rejected before it replaces the composed set or its absence reporter', async () => {
  // A rejected set must not be able to install its own absence policy: the composition owns that
  // policy once, so checking ownership happens before any state changes (#4781 review). Runs on a
  // fresh registry module so it owns the set it composes rather than depending on another scenario.
  vi.resetModules();
  const registry = await import('./platform-plugin-registry.ts');
  const composedAbsence: PlatformPluginAbsence = (family) =>
    new AppError('UNSUPPORTED_PLATFORM', `Composed absence: ${family}`, {
      reason: 'plugin-not-installed',
      family,
    });
  const builtins = [pluginOwning('apple', ['apple']), pluginOwning('android', ['android'])];
  const set = registry.registerPlatformPluginSet(builtins, composedAbsence);
  assert.equal(set.get('apple').plugin.id, 'apple');
  assert.throws(
    () => set.get('web'),
    (error: unknown) => error instanceof AppError && error.message === 'Composed absence: web',
  );

  const rejectedAbsence: PlatformPluginAbsence = (family) =>
    new AppError('UNSUPPORTED_PLATFORM', `Rejected absence: ${family}`);
  // One plugin that claims both a free platform and a taken one: the whole set is rejected, so
  // even the free platform cannot reach the registry ahead of the rejection.
  assert.throws(
    () =>
      registry.registerPlatformPluginSet(
        [...builtins, pluginOwning('web-and-apple', ['web', 'apple'])],
        rejectedAbsence,
      ),
    /Duplicate platform family registration: apple/,
  );

  // Neither the duplicate's platform nor its absence policy reached the registry.
  assert.equal(set.tryGet('web'), undefined);
  assert.throws(
    () => set.get('web'),
    (error: unknown) => error instanceof AppError && error.message === 'Composed absence: web',
  );
});
