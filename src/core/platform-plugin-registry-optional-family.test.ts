import type { PlatformProviderRequestContext } from '@agent-device/contracts/platform-providers';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

// Simulates a composition whose builtin plugins do not include the extracted `vega` family:
// the module-level self-registration inside request-providers must then register only the five
// remaining builtins, leaving `vega` absent from the platform-plugin registry.
vi.mock('./interactors/register-builtins.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./interactors/register-builtins.ts')>();
  const { registerPlatformPlugin } = await import('./platform-plugin-registry.ts');
  return {
    ...original,
    registerBuiltinPlatformPlugins: () => {
      for (const plugin of original.BUILTIN_PLATFORM_PLUGINS) {
        if (plugin.id !== 'vega') registerPlatformPlugin(plugin);
      }
    },
  };
});

test('the request-provider scope for an absent optional family gates nothing and lets the task run', async () => {
  // The private request-provider composition submodule is reached only through the root
  // composition wrapper (R13), exactly as the daemon request path does. A provider-owned device
  // of an absent family must still reach its provider interactor, so the scope does not fail;
  // the typed plugin-not-installed outcome comes from the inventory and runtime lookups.
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
});
