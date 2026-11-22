import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HarmonyPlatformRegistration } from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from 'agent-device/plugins';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { isExecutablePath, whichCmd } from '@agent-device/host-kit/command';
import { hostFileExists } from '@agent-device/host-kit/host-file';
import path from 'node:path';
import harmonyPlatformPlugin from './index.ts';
import { createHarmonyToolchainRoot } from './toolbox.fixtures.ts';

const HARMONY_DEVICE = {
  platform: 'harmonyos',
  id: 'harmony-device',
  name: 'HarmonyOS',
  kind: 'device',
  target: 'mobile',
  booted: true,
} satisfies DeviceInfo;

/** One command the plugin asked the host to run. */
type HostCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env: PlatformHost['env'] | undefined;
}>;

/** The host the composition hands the plugin: one captured environment, no device authority. */
function createPluginHost(
  env: PlatformHost['env'] = {},
  commands: HostCommand[] = [],
): PlatformHost {
  return {
    env,
    cwd: '/host-cwd',
    stateDir: '/host-state',
    // What the host says about the machine its commands run on. This family never reads these: its
    // devices are reached over HDC, and no install layout or launch argv is derived from them.
    hostOs: 'linux',
    nodeExecutablePath: '/usr/bin/node',
    nodeVersion: 'v24.0.0',
    temporaryDirectory: '/tmp',
    processId: 4242,
    runCommand: async (executable, args, options) => {
      commands.push({ executable, args, env: options.env });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    // The host probe the real one is: a test that names a toolchain root proves the plugin resolves
    // HDC from a file on disk, not from a verdict this fixture hands it.
    isFileExecutable: isExecutablePath,
    isFilePresent: hostFileExists,
    isExecutableOnPath: async (executable) => await whichCmd(executable, env),
    // Neither this family nor its devices are host processes: everything goes through HDC.
    processes: {
      list: async () => [],
      readIdentities: async () => new Map(),
      expandTree: (rootPids, processes) =>
        [...processes].filter((processInfo) => [...rootPids].includes(processInfo.pid)),
      judgeRecordedLiveness: async (records) => [...records].map(() => 'unobserved' as const),
      readExecutablePaths: async () => new Map(),
      reapOwnedRecords: async () => {
        throw new Error('the HarmonyOS family never reaps host processes');
      },
      withLock: async () => {
        throw new Error('the HarmonyOS family takes no host lock');
      },
    } satisfies PlatformHost['processes'],
    // This host is asked for neither: the tests that stream `hilog` use the toolbox stub, which
    // records the managed process the family starts, and nothing starts a detached process.
    startBackgroundCommand: async () => {
      throw new Error('this host is not asked to keep a command running');
    },
    launchDetached: async () => {
      throw new Error('the HarmonyOS family starts no detached process');
    },
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
});

test('the HarmonyOS inventory loads with no host from the core', async () => {
  // The family owns its host: discovery runs over the setup host, so the core hands the inventory
  // module nothing. A signature that still demanded a core host would fail here.
  const registration = setupHarmonyPlatform();
  const source = await registration.inventoryModule.loadInventory();
  assert.equal(typeof source.discover, 'function');
});

test('setup runs discovery on the host it was set up with, not on the process environment', async () => {
  // The plugin never reads `process.env`: the documented HarmonyOS roots reach discovery through the
  // setup host only. The process environment names a different root on purpose, so an implementation
  // that read it instead of the host fails here on any machine.
  vi.stubEnv('HDC_SDK_PATH', '/process-tools/toolchains');
  vi.stubEnv('DEVECO_SDK_HOME', '/process-tools/deveco');
  vi.stubEnv('HARMONYOS_COMMAND_LINE_TOOLS', undefined);
  const hostRoot = createHarmonyToolchainRoot();
  const commands: HostCommand[] = [];
  const registration = setupHarmonyPlatform(
    createPluginHost(
      {
        HDC_SDK_PATH: hostRoot,
        DEVECO_SDK_HOME: '/host-tools/deveco',
        HARMONYOS_COMMAND_LINE_TOOLS: '',
        PATH: '/bin',
      },
      commands,
    ),
  );

  const source = await registration.inventoryModule.loadInventory();
  await source.discover({}, scope);

  // Only the host's root, which really carries an executable HDC, is spawned and prepended to PATH.
  assert.equal(commands[0]?.executable, path.join(hostRoot, 'hdc'));
  assert.equal(commands[0]?.env?.PATH?.split(path.delimiter)[0], hostRoot);
  assert.ok(!commands[0]!.env!.PATH!.includes('/process-tools/toolchains'));
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
