import type { PlatformProviderRequestContext } from '@agent-device/contracts/platform-providers';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

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

test('the request-provider lookup for an absent optional family fails plugin-not-installed before the task runs', async () => {
  // The private request-provider composition submodule is reached only through the root
  // composition wrapper (R13), exactly as the daemon request path does.
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
  const providers = createRequestPlatformProviders({
    providers: { vegaToolProvider: () => undefined },
  });

  let taskRan = false;
  const failure = await providers
    .run(context, async () => {
      taskRan = true;
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  assert.ok(failure instanceof AppError, `expected AppError, got ${String(failure)}`);
  assert.equal(failure.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(failure.details?.reason, 'plugin-not-installed');
  assert.equal(failure.details?.family, 'vega');
  assert.equal(failure.details?.package, '@agent-device/vega');
  assert.equal(failure.details?.installCommand, 'agent-device plugins add @agent-device/vega');
  assert.match(String(failure.details?.hint), /agent-device plugins add @agent-device\/vega/);
  // The lookup fails before the request task — and therefore before any device binding — runs.
  assert.equal(taskRan, false);
});
