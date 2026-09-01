import { afterAll, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { pressLinux } from '../input-actions.ts';
import { resetInputToolCache } from '../linux-env.ts';
import { createLocalLinuxToolProvider, withLinuxToolProvider } from '../tool-provider.ts';

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env['XDG_SESSION_TYPE'] = 'x11';
  delete process.env['WAYLAND_DISPLAY'];
  resetInputToolCache();
});

test('scoped Linux tool provider handles input discovery and command execution', async () => {
  const commands: Array<[string, string[]]> = [];
  const provider = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => cmd === 'xdotool',
    runCommand: async (cmd, args) => {
      commands.push([cmd, args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await withLinuxToolProvider(provider, async () => {
    await pressLinux(100, 200);
  });

  assert.deepEqual(commands, [
    // The position probe guards the --sync move: a no-op move emits no motion event and hangs.
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['mousemove', '--sync', '100', '200']],
    ['xdotool', ['click', '1']],
  ]);
});

test('xdotool press skips the --sync move when the pointer already sits on the target', async () => {
  const commands: Array<[string, string[]]> = [];
  const provider = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => cmd === 'xdotool',
    runCommand: async (cmd, args) => {
      commands.push([cmd, args]);
      const stdout = args[0] === 'getmouselocation' ? 'X=100\nY=200\nSCREEN=0\nWINDOW=1' : '';
      return { exitCode: 0, stdout, stderr: '' };
    },
  });

  await withLinuxToolProvider(provider, async () => {
    await pressLinux(100, 200);
  });

  // No mousemove: moving to the current position would wait forever for a motion event.
  assert.deepEqual(commands, [
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['click', '1']],
  ]);
});

test('scoped Linux input provider handles semantic input without host tool discovery', async () => {
  const inputCalls: Array<[string, string, string, string]> = [];
  const provider = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => {
      throw new Error(`unexpected input discovery: ${cmd}`);
    },
    runCommand: async (cmd) => {
      throw new Error(`unexpected host input command: ${cmd}`);
    },
    input: {
      click: async (x, y, button) => {
        inputCalls.push(['click', String(x), String(y), button]);
      },
      doubleClick: async () => {},
      longPress: async () => {},
      drag: async () => {},
      scroll: async () => {},
      typeText: async () => {},
      key: async () => {},
    },
  });

  await withLinuxToolProvider(provider, async () => {
    await pressLinux(100, 200);
  });

  assert.deepEqual(inputCalls, [['click', '100', '200', 'primary']]);
});

test('Linux tool provider scopes do not share cached input tool resolution', async () => {
  const providerA = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => cmd === 'xdotool',
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  const providerB = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => cmd === 'ydotool',
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });

  await withLinuxToolProvider(providerA, async () => {
    await pressLinux(1, 2);
  });

  process.env['XDG_SESSION_TYPE'] = 'wayland';
  process.env['WAYLAND_DISPLAY'] = 'wayland-0';
  const commands: Array<[string, string[]]> = [];

  await withLinuxToolProvider(
    createLocalLinuxToolProvider({
      ...providerB,
      runCommand: async (cmd, args) => {
        commands.push([cmd, args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => {
      await pressLinux(3, 4);
    },
  );

  assert.deepEqual(commands, [
    ['ydotool', ['mousemove', '--absolute', '-x', '3', '-y', '4']],
    ['ydotool', ['click', '0xC0']],
  ]);
});

test('local Linux desktop provider translates semantic lifecycle calls to host tools', async () => {
  const commands: Array<[string, string[], boolean | undefined]> = [];
  const provider = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => cmd === 'wmctrl',
    runCommand: async (cmd, args, options) => {
      commands.push([cmd, args, options?.allowFailure]);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await provider.desktop.openTarget('https://example.test');
  await provider.desktop.openTarget('demo.desktop');
  await provider.desktop.closeApp('Demo');

  assert.deepEqual(commands, [
    ['xdg-open', ['https://example.test'], undefined],
    ['xdg-open', ['demo.desktop'], true],
    ['wmctrl', ['-c', 'Demo'], true],
  ]);
});

test('local Linux desktop provider falls back to pkill when wmctrl is unavailable', async () => {
  const commands: Array<[string, string[], boolean | undefined]> = [];
  const provider = createLocalLinuxToolProvider({
    whichCommand: async () => false,
    runCommand: async (cmd, args, options) => {
      commands.push([cmd, args, options?.allowFailure]);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await provider.desktop.closeApp('Demo');

  assert.deepEqual(commands, [['pkill', ['-x', 'Demo'], true]]);
});

test('local Linux screenshot provider translates capture to available host tool', async () => {
  const commands: Array<[string, string[]]> = [];
  const provider = createLocalLinuxToolProvider({
    whichCommand: async (cmd) => cmd === 'scrot',
    runCommand: async (cmd, args) => {
      commands.push([cmd, args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await provider.screenshot!.capture('/tmp/screen.png');

  assert.deepEqual(commands, [['scrot', ['/tmp/screen.png']]]);
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});
