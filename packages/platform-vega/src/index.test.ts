import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { VegaPlatformRegistration } from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from 'agent-device/plugins';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { isExecutablePath } from '@agent-device/host-kit/command';
import vegaPlatformPlugin from './index.ts';
import { createVegaDefaultInstall, createVegaHostHome } from './command-host.fixtures.ts';

const VEGA_VVD = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} satisfies DeviceInfo;

/** One command the plugin asked the host to run. */
type HostCommand = Readonly<{
  executable: string;
  args: readonly string[];
}>;

/**
 * The host the composition hands the plugin: one captured environment, no device authority. The PATH
 * lookup is the host's own reading of the environment it was given, so a plugin that searched the
 * process environment instead of this host gets a different answer here.
 */
function createPluginHost(
  input: Readonly<{
    env?: PlatformHost['env'];
    onPath?: readonly string[];
    commands?: HostCommand[];
  }> = {},
): PlatformHost {
  const onPath = new Set(input.onPath ?? ['vega']);
  return {
    env: input.env ?? {},
    cwd: '/host-cwd',
    stateDir: '/host-state',
    // What the host says about the machine its commands run on. This family never reads these: its
    // devices are reached over HDC, and no install layout or launch argv is derived from them.
    hostOs: 'linux',
    nodeExecutablePath: '/usr/bin/node',
    nodeVersion: 'v24.0.0',
    temporaryDirectory: '/tmp',
    processId: 4242,
    runCommand: async (executable, args) => {
      input.commands?.push({ executable, args });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    // The real host probe: a test that names a home proves the plugin resolves the CLI from a file
    // on disk, not from a verdict this fixture hands it.
    isFileExecutable: isExecutablePath,
    isExecutableOnPath: async (executable) => onPath.has(executable),
    // Neither this family nor its devices are host processes: everything goes through the Vega CLI.
    processes: {
      list: async () => [],
      readIdentities: async () => new Map(),
      expandTree: (rootPids, processes) =>
        [...processes].filter((processInfo) => [...rootPids].includes(processInfo.pid)),
      judgeRecordedLiveness: async (records) => [...records].map(() => 'unobserved' as const),
      readExecutablePaths: async () => new Map(),
      reapOwnedRecords: async () => {
        throw new Error('the Vega family never reaps host processes');
      },
      withLock: async () => {
        throw new Error('the Vega family takes no host lock');
      },
    } satisfies PlatformHost['processes'],
    emitDiagnostic,
    withDiagnosticTimer,
  };
}

function setupVegaPlatform(host?: PlatformHost): VegaPlatformRegistration {
  return vegaPlatformPlugin().contributes[0].setup(
    host ?? createPluginHost(),
  ) as VegaPlatformRegistration;
}

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('the Vega package contributes the Vega platform family', () => {
  const plugin = vegaPlatformPlugin();
  const [contribution] = plugin.contributes;

  assert.equal(plugin.apiVersion, 3);
  assert.equal(plugin.contributes.length, 1);
  assert.equal(contribution.kind, 'platform');
  assert.equal(contribution.family, 'vega');
});

test('setup registers the Vega modules, request scoping and operations', () => {
  const registration = setupVegaPlatform();

  assert.equal(registration.family, 'vega');
  assert.equal(registration.inventoryModule.family, 'vega');
  assert.equal(registration.runtimeModule.family, 'vega');
  assert.equal(typeof registration.inventoryModule.loadInventory, 'function');
  assert.equal(typeof registration.runtimeModule.loadRuntime, 'function');
  assert.equal(typeof registration.withRequestProvider, 'function');
  assert.equal(typeof registration.operations.toolchainCheck, 'function');
});

test('the Vega inventory loads with no host from the core', async () => {
  // The family owns its host: discovery runs over the setup host, so the core hands the inventory
  // module nothing. A signature that still demanded a core host would fail here.
  const registration = setupVegaPlatform();
  const source = await registration.inventoryModule.loadInventory();
  assert.equal(typeof source.discover, 'function');
});

test('setup runs discovery on the host it was set up with, not on the process environment', async () => {
  // The plugin never reads `process.env`: the CLI's default install reaches discovery through the
  // setup host only. The process home has no `vega/bin/vega`, so an implementation that read it
  // instead of the host reports the CLI missing on any machine.
  const home = createVegaHostHome();
  const install = createVegaDefaultInstall(home);
  const commands: HostCommand[] = [];
  const registration = setupVegaPlatform(
    createPluginHost({ env: { HOME: home, PATH: '/bin' }, onPath: [], commands }),
  );

  const source = await registration.inventoryModule.loadInventory();
  await source.discover({}, scope);

  assert.equal(commands[0]?.executable, install);
  assert.deepEqual(commands[0]?.args, ['device', 'list']);
});

test('setup creates the Vega interactor lazily', async () => {
  const registration = setupVegaPlatform();
  const interactor = await registration.createInteractor(
    VEGA_VVD,
    {},
    { env: {}, cwd: '/host-cwd' },
  );

  assert.equal(typeof interactor.tvRemote, 'function');
  assert.equal(typeof interactor.back, 'function');
  assert.equal(typeof interactor.home, 'function');
});

test('setup binds its own host into every interactor it returns', async () => {
  // Two setups, two hosts: one carries the CLI on its host PATH, the other only under its host home.
  // Each interactor must spawn the CLI its own setup host resolved, so a second runtime never runs
  // the first runtime's binary (#3794).
  const home = createVegaHostHome();
  const install = createVegaDefaultInstall(home);
  const pathCommands: HostCommand[] = [];
  const homeCommands: HostCommand[] = [];
  const pathInteractor = await setupVegaPlatform(
    createPluginHost({ env: { PATH: '/bin' }, onPath: ['vega'], commands: pathCommands }),
  ).createInteractor(VEGA_VVD, {}, { env: {}, cwd: '/host-cwd' });
  const homeInteractor = await setupVegaPlatform(
    createPluginHost({ env: { HOME: home, PATH: '/bin' }, onPath: [], commands: homeCommands }),
  ).createInteractor(VEGA_VVD, {}, { env: {}, cwd: '/host-cwd' });

  await pathInteractor.back();
  await homeInteractor.back();

  assert.deepEqual(
    pathCommands.map(({ executable }) => executable),
    ['vega'],
  );
  assert.deepEqual(
    homeCommands.map(({ executable }) => executable),
    [install],
  );
});
