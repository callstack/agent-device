import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { LinuxPlatformRegistration } from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from 'agent-device/plugins';
import linuxPlatformPlugin from './index.ts';

/** One command the plugin asked the host to run. */
type HostCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env: PlatformHost['env'] | undefined;
}>;

/**
 * The host the composition hands the plugin: one captured environment, and probes and spawns that
 * record what the plugin asked rather than touching this machine.
 */
function createPluginHost(
  input: Readonly<{
    env?: PlatformHost['env'];
    tools?: Iterable<string>;
    commands?: HostCommand[];
    launches?: Array<Readonly<{ executable: string; args: readonly string[] }>>;
  }> = {},
): PlatformHost {
  const tools = input.tools ? new Set(input.tools) : undefined;
  const commands = input.commands ?? [];
  return {
    env: input.env ?? { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    cwd: '/host-cwd',
    stateDir: '/host-state',
    runCommand: async (executable, args, options) => {
      commands.push({ executable, args, env: options.env });
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    isFileExecutable: async (candidate) =>
      tools === undefined ? false : tools.has(candidate.split('/').pop() ?? candidate),
    launchDetached: async (executable, args) => {
      input.launches?.push({ executable, args });
      return { pid: 4242, exited: Promise.resolve({ pid: 4242, exitCode: 0 }) };
    },
    emitDiagnostic: () => {},
    withDiagnosticTimer: async (_phase, operation) => await operation(),
  };
}

function setupLinuxPlatform(host: PlatformHost = createPluginHost()): LinuxPlatformRegistration {
  return linuxPlatformPlugin().contributes[0].setup(host) as LinuxPlatformRegistration;
}

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('the Linux package contributes the Linux platform family', () => {
  const plugin = linuxPlatformPlugin();
  const [contribution] = plugin.contributes;

  assert.equal(plugin.apiVersion, 3);
  assert.equal(plugin.contributes.length, 1);
  assert.equal(contribution.kind, 'platform');
  assert.equal(contribution.family, 'linux');
});

test('setup registers the Linux modules and operations', () => {
  const registration = setupLinuxPlatform();

  assert.equal(registration.family, 'linux');
  assert.equal(registration.inventoryModule.family, 'linux');
  assert.equal(registration.runtimeModule.family, 'linux');
  assert.equal(typeof registration.inventoryModule.loadInventory, 'function');
  assert.equal(typeof registration.runtimeModule.loadRuntime, 'function');
  assert.equal(typeof registration.createInteractor, 'function');
  assert.equal(typeof registration.withRequestProvider, 'function');
  assert.equal(typeof registration.operations.toolchainCheck, 'function');
});

test('setup binds nothing until an operation asks the host', async () => {
  // Every host port throws: importing the package and calling `setup` must stay metadata-only, so
  // the daemon's start-up cost does not include this family's command route.
  const hostileHost = {
    ...createPluginHost(),
    runCommand: async () => {
      throw new Error('setup must not spawn');
    },
    isFileExecutable: async () => {
      throw new Error('setup must not probe');
    },
    launchDetached: () => {
      throw new Error('setup must not launch');
    },
  } as PlatformHost;

  const registration = setupLinuxPlatform(hostileHost);
  assert.equal(registration.family, 'linux');
});

test('the Linux inventory reports the desktop device of a Linux host', async () => {
  const registration = setupLinuxPlatform();
  const source = await registration.inventoryModule.loadInventory({
    hostName: 'builder',
    hostOs: 'linux',
  });

  assert.deepEqual(await source.discover({}, scope), [
    {
      platform: 'linux',
      id: 'local',
      name: 'builder',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
  ]);
});

test('the Linux inventory reports nothing on another host', async () => {
  const registration = setupLinuxPlatform();
  const source = await registration.inventoryModule.loadInventory({
    hostName: 'laptop',
    hostOs: 'darwin',
  });

  assert.deepEqual(await source.discover({}, scope), []);
});

test('the toolchain check probes the host the plugin was set up with', async () => {
  const tools = ['xdotool', 'xclip', 'scrot', 'python3'];
  const host = createPluginHost({
    env: { PATH: '/opt/tools:/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools,
  });
  const probed: string[] = [];
  const registration = setupLinuxPlatform({
    ...host,
    isFileExecutable: async (candidate) => {
      probed.push(candidate);
      return await host.isFileExecutable(candidate);
    },
  });

  const check = await registration.operations.toolchainCheck();

  assert.equal(check.id, 'toolchain');
  assert.equal(check.status, 'pass');
  // The probe is the host's, over the host PATH, for the tools the X11 session needs.
  assert.deepEqual(probed, tools.map((tool) => `/opt/tools/${tool}`));
});

test('the toolchain check reports the tools the host is missing', async () => {
  const registration = setupLinuxPlatform(
    createPluginHost({
      env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
      tools: ['python3'],
    }),
  );

  const check = await registration.operations.toolchainCheck();

  assert.equal(check.status, 'fail');
  assert.match(check.summary, /xdotool/);
  assert.deepEqual(check.evidence, {
    display: 'x11',
    tools: ['python3'],
    missingTools: ['xdotool', 'xclip', 'scrot'],
  });
});

test('the toolchain check reads the display decision from the host environment (#3794)', async () => {
  const registration = setupLinuxPlatform(
    createPluginHost({
      env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
      tools: ['ydotool', 'wl-paste', 'wl-copy', 'grim', 'python3'],
    }),
  );

  const check = await registration.operations.toolchainCheck();

  assert.equal(check.status, 'pass');
  assert.match(check.summary, /wayland/);
});

test('the Linux interactor drives the host the plugin was set up with', async () => {
  const commands: HostCommand[] = [];
  const registration = setupLinuxPlatform(
    createPluginHost({
      env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
      tools: ['xdotool'],
      commands,
    }),
  );
  const interactor = await registration.createInteractor(
    {
      platform: 'linux',
      id: 'local',
      name: 'builder',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
    {},
    { env: {}, cwd: '/host-cwd' },
  );

  await interactor.tap(100, 200);

  assert.deepEqual(
    commands.map((command) => [command.executable, [...command.args]]),
    [
      ['xdotool', ['getmouselocation', '--shell']],
      ['xdotool', ['mousemove', '--sync', '100', '200']],
      ['xdotool', ['click', '1']],
    ],
  );
  // The environment is the setup host's, not the process's: the daemon's own environment never
  // enters the bundle, and the request's display decision would be lost if it did.
  assert.equal(commands[0]?.env?.XDG_SESSION_TYPE, 'x11');
});

test('a request-scoped provider answers the interactor instead of the setup host', async () => {
  const hostCommands: HostCommand[] = [];
  const registration = setupLinuxPlatform(
    createPluginHost({
      env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
      tools: ['xdotool'],
      commands: hostCommands,
    }),
  );
  const scopedCommands: Array<[string, readonly string[]]> = [];
  const scoped = {
    display: { detectDisplayServer: () => 'x11' as const },
    runCommand: async (cmd: string, args: readonly string[]) => {
      scopedCommands.push([cmd, args]);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    whichCommand: async (cmd: string) => cmd === 'xdotool',
    launchDetached: () => ({ exited: Promise.resolve({ pid: 1, exitCode: 0 }) }),
    sleep: async () => {},
    desktop: {
      openTarget: async () => {},
      closeApp: async () => {},
    },
  };
  const interactor = await registration.createInteractor(
    {
      platform: 'linux',
      id: 'local',
      name: 'builder',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
    {},
    { env: {}, cwd: '/host-cwd' },
  );

  await registration.withRequestProvider(scoped, async () => {
    await interactor.tap(1, 2);
  });

  assert.deepEqual(scopedCommands, [
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['mousemove', '--sync', '1', '2']],
    ['xdotool', ['click', '1']],
  ]);
  assert.equal(hostCommands.length, 0);
});

test('two setups keep separate host environments', async () => {
  const x11Commands: HostCommand[] = [];
  const waylandCommands: HostCommand[] = [];
  const device = {
    platform: 'linux' as const,
    id: 'local',
    name: 'builder',
    kind: 'device' as const,
    target: 'desktop' as const,
    booted: true,
  };

  const x11 = await setupLinuxPlatform(
    createPluginHost({
      env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
      tools: ['xdotool'],
      commands: x11Commands,
    }),
  ).createInteractor(device, {}, { env: {}, cwd: '/host-cwd' });
  const wayland = await setupLinuxPlatform(
    createPluginHost({
      env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
      tools: ['ydotool'],
      commands: waylandCommands,
    }),
  ).createInteractor(device, {}, { env: {}, cwd: '/host-cwd' });

  await x11.tap(1, 2);
  await wayland.tap(3, 4);

  assert.deepEqual(
    x11Commands.map((command) => command.executable),
    ['xdotool', 'xdotool', 'xdotool'],
  );
  assert.deepEqual(
    waylandCommands.map((command) => command.executable),
    ['ydotool', 'ydotool'],
  );
});
