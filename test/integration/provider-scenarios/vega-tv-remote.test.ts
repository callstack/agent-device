import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VegaTvRemoteKey } from '../../../src/contracts/tv-remote.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { VegaToolProvider } from '../../../src/platforms/vega/tool-provider.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

const VEGA_TV: DeviceInfo = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device (VirtualDevice)',
  kind: 'emulator',
  target: 'tv',
  booted: true,
};

const APP_ID = 'com.example.vega.main';
const SELECTION = {
  platform: 'vega',
  target: 'tv',
  serial: VEGA_TV.id,
} as const;

test('Provider-backed Vega TV flow routes lifecycle and every remote control as semantic intents', async () => {
  const calls: VegaIntent[] = [];
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const vegaToolProvider: VegaToolProvider = {
    isAvailable: async () => true,
    version: async () => ok,
    listDevices: async () => ok,
    checkConnected: async (deviceId) => {
      calls.push({ intent: 'checkConnected', deviceId });
      return ok;
    },
    launchApp: async (deviceId, appName) => {
      calls.push({ intent: 'launchApp', deviceId, appName });
      return ok;
    },
    terminateApp: async (deviceId, appName) => {
      calls.push({ intent: 'terminateApp', deviceId, appName });
      return ok;
    },
    pressRemote: async (deviceId, key, durationMs) => {
      calls.push({ intent: 'pressRemote', deviceId, key, durationMs });
      return ok;
    },
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        vegaToolProvider: () => vegaToolProvider,
        deviceInventoryProvider: async () => [VEGA_TV],
      }),
    async (daemon) => {
      daemon.setSession('default', {
        name: 'default',
        device: VEGA_TV,
        createdAt: Date.now(),
        actions: [],
      });

      const open = await daemon.callCommand('open', [APP_ID], SELECTION);
      assertRpcOk(open);

      for (const button of ['up', 'down', 'left', 'right', 'select', 'menu', 'home', 'back']) {
        const response = await daemon.callCommand('tv-remote', [button], SELECTION);
        assert.equal(assertRpcOk(response).button, button);
      }

      for (const alias of ['ok', 'center', 'enter']) {
        const response = await daemon.callCommand('tv-remote', [alias], SELECTION);
        assert.equal(assertRpcOk(response).button, 'select');
      }

      const held = await daemon.callCommand('tv-remote', ['select'], {
        ...SELECTION,
        durationMs: 725,
      });
      assert.equal(assertRpcOk(held).durationMs, 725);

      assertRpcOk(await daemon.callCommand('back', [], SELECTION));
      assertRpcOk(await daemon.callCommand('home', [], SELECTION));

      assert.deepEqual(
        daemon.session()?.actions.map((action) => action.command),
        [
          'open',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'tv-remote',
          'back',
          'home',
        ],
      );

      assertRpcOk(await daemon.callCommand('close', [APP_ID], SELECTION));
      assert.deepEqual(calls, expectedVegaCalls());
      assert.equal(daemon.session(), undefined);
    },
  );
});

type VegaIntent =
  | { intent: 'checkConnected'; deviceId: string }
  | { intent: 'launchApp' | 'terminateApp'; deviceId: string; appName: string }
  | {
      intent: 'pressRemote';
      deviceId: string;
      key: VegaTvRemoteKey;
      durationMs: number | undefined;
    };

function expectedVegaCalls(): VegaIntent[] {
  const lifecycleStart = [{ intent: 'launchApp' as const, deviceId: VEGA_TV.id, appName: APP_ID }];
  const remoteKeys = [
    'KEY_UP',
    'KEY_DOWN',
    'KEY_LEFT',
    'KEY_RIGHT',
    'KEY_ENTER',
    'KEY_MENU',
    'KEY_HOMEPAGE',
    'KEY_BACK',
    'KEY_ENTER',
    'KEY_ENTER',
    'KEY_ENTER',
  ].map((key) => vegaRemoteIntent(key as VegaTvRemoteKey));
  const exactHold = [
    vegaRemoteIntent('KEY_ENTER', 725),
    vegaRemoteIntent('KEY_BACK'),
    vegaRemoteIntent('KEY_HOMEPAGE'),
  ];
  const lifecycleEnd = [{ intent: 'terminateApp' as const, deviceId: VEGA_TV.id, appName: APP_ID }];
  return [...lifecycleStart, ...remoteKeys, ...exactHold, ...lifecycleEnd];
}

function vegaRemoteIntent(key: VegaTvRemoteKey, durationMs?: number): VegaIntent {
  return { intent: 'pressRemote', deviceId: VEGA_TV.id, key, durationMs };
}
