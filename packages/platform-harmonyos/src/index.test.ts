import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HarmonyPlatformRegistration } from '@agent-device/contracts/platform-plugin';
import type { DeviceInventoryHostFor } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformHost } from 'agent-device/plugins';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import harmonyPlatformPlugin from './index.ts';

const HARMONY_DEVICE = {
  platform: 'harmonyos',
  id: 'harmony-device',
  name: 'HarmonyOS',
  kind: 'device',
  target: 'mobile',
  booted: true,
} satisfies DeviceInfo;

/** The host the composition hands the plugin: one captured environment, no device authority. */
function createPluginHost(env: PlatformHost['env'] = {}): PlatformHost {
  return {
    env,
    cwd: '/host-cwd',
    stateDir: '/host-state',
    runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    emitDiagnostic,
    withDiagnosticTimer,
  };
}

function setupHarmonyPlatform(host?: PlatformHost): HarmonyPlatformRegistration {
  return harmonyPlatformPlugin().contributes[0].setup(
    host ?? createPluginHost(),
  ) as HarmonyPlatformRegistration;
}

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('the HarmonyOS package contributes the HarmonyOS platform family', () => {
  const plugin = harmonyPlatformPlugin();
  const [contribution] = plugin.contributes;

  assert.equal(plugin.apiVersion, 3);
  assert.equal(plugin.contributes.length, 1);
  assert.equal(contribution.kind, 'platform');
  assert.equal(contribution.family, 'harmonyos');
});

test('setup registers the HarmonyOS modules and operations', () => {
  const registration = setupHarmonyPlatform();

  assert.equal(registration.family, 'harmonyos');
  assert.equal(registration.inventoryModule.family, 'harmonyos');
  assert.equal(registration.runtimeModule.family, 'harmonyos');
  assert.equal(typeof registration.inventoryModule.loadInventory, 'function');
  assert.equal(typeof registration.runtimeModule.loadRuntime, 'function');
  assert.equal(typeof registration.operations.toolchainCheck, 'function');
  assert.equal(typeof registration.operations.prepareToolchain, 'function');
});

test('setup hands the host it was set up with to the inventory module it registers', async () => {
  // The plugin never reads `process.env`: the documented HarmonyOS roots reach discovery through
  // the setup host only. Discovery asks the host to prepare its toolchain first, then resolves HDC
  // through the roots and PATH that preparation owns, so a host without either answers its own
  // missing-toolchain reason. The process environment names a different root on purpose, so an
  // implementation that read it instead of the host fails here on any machine.
  const originalRoots = {
    HDC_SDK_PATH: process.env.HDC_SDK_PATH,
    DEVECO_SDK_HOME: process.env.DEVECO_SDK_HOME,
    HARMONYOS_COMMAND_LINE_TOOLS: process.env.HARMONYOS_COMMAND_LINE_TOOLS,
  };
  process.env.HDC_SDK_PATH = '/process-tools/hdc';
  process.env.DEVECO_SDK_HOME = '/process-tools/deveco';
  delete process.env.HARMONYOS_COMMAND_LINE_TOOLS;
  try {
    const registration = setupHarmonyPlatform(
      createPluginHost({
        HDC_SDK_PATH: ' /host-tools/hdc ',
        DEVECO_SDK_HOME: '/host-tools/deveco',
        HARMONYOS_COMMAND_LINE_TOOLS: '',
        PATH: '/bin',
      }),
    );
    const lookedUp: string[] = [];
    let prepares = 0;
    const inventoryHost = {
      toolchains: {
        prepare: async () => {
          prepares += 1;
        },
      },
      commands: {
        which: async (command: string) => {
          lookedUp.push(command);
          return undefined;
        },
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
      files: {
        isExecutable: async (candidate: string) => {
          lookedUp.push(candidate);
          return false;
        },
      },
      hostOs: 'darwin',
      hostName: 'test-host',
    } as unknown as DeviceInventoryHostFor<'harmonyos'>;

    const source = await registration.inventoryModule.loadInventory(inventoryHost);
    await assert.rejects(
      async () => await source.discover({}, scope),
      (error: Error) => error.message === 'hdc not found in PATH',
    );
    assert.equal(prepares, 1);
    // Each root the setup host named is probed, trimmed, and derived; the empty root and the
    // process environment's roots are not.
    assert.deepEqual(lookedUp, [
      '/host-tools/hdc/hdc',
      '/host-tools/deveco/default/openharmony/toolchains/hdc',
      'hdc',
    ]);
  } finally {
    Object.assign(process.env, originalRoots);
    if (originalRoots.HARMONYOS_COMMAND_LINE_TOOLS === undefined)
      delete process.env.HARMONYOS_COMMAND_LINE_TOOLS;
  }
});

test('setup creates the HarmonyOS interactor lazily', async () => {
  const registration = setupHarmonyPlatform();
  const interactor = await registration.createInteractor(
    HARMONY_DEVICE,
    {},
    {
      env: {},
      cwd: '/host-cwd',
    },
  );

  assert.equal(typeof interactor.snapshot, 'function');
  assert.equal(typeof interactor.tap, 'function');
});
