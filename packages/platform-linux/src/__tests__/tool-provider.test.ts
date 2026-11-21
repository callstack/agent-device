import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createLinuxHostStub, type LinuxHostStub } from '../toolbox.fixtures.ts';
import { createLinuxToolProvider } from '../tool-provider.ts';
import { pressLinux } from '../input-actions.ts';
import type { LinuxToolProviderOverrides } from '../tool-provider.ts';

function x11Stub(tools: readonly string[] = ['xdotool'], overrides: LinuxHostOverrides = {}) {
  return createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools,
    ...overrides,
  });
}

function waylandStub(tools: readonly string[] = ['ydotool']) {
  return createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
    tools,
  });
}

type LinuxHostOverrides = Partial<Parameters<typeof createLinuxHostStub>[0]>;

/**
 * The provider under test. Interaction pacing is replaced so a test about which tool ran never
 * waits on a real clock; the pacing itself is asserted separately.
 */
function providerFor(stub: LinuxHostStub, overrides: LinuxToolProviderOverrides = {}) {
  return createLinuxToolProvider(stub.toolbox, { sleep: async () => {}, ...overrides });
}

const tuples = (
  commands: readonly { executable: string; args: readonly string[] }[],
): Array<[string, string[]]> =>
  commands.map((c) => [c.executable, [...c.args]] as [string, string[]]);

test('the provider routes input through the tool its host reports', async () => {
  const stub = x11Stub();

  await pressLinux(providerFor(stub), 100, 200);

  assert.deepEqual(tuples(stub.commands), [
    // The position probe guards the --sync move: a no-op move emits no motion event and hangs.
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['mousemove', '--sync', '100', '200']],
    ['xdotool', ['click', '1']],
  ]);
});

test('the provider hands every command the host environment it was set up with', async () => {
  const stub = x11Stub();

  await pressLinux(providerFor(stub), 1, 2);

  assert.ok(stub.commands.length > 0);
  for (const command of stub.commands) {
    assert.equal(command.env?.XDG_SESSION_TYPE, 'x11');
    assert.equal(command.env?.PATH, '/usr/bin');
  }
});

test('xdotool press skips the --sync move when the pointer already sits on the target', async () => {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: ['xdotool'],
    respond: (executable, args) =>
      executable === 'xdotool' && args[0] === 'getmouselocation'
        ? { stdout: 'X=100\nY=200\nSCREEN=0\nWINDOW=1' }
        : {},
  });

  await pressLinux(providerFor(stub), 100, 200);

  // No mousemove: moving to the current position would wait forever for a motion event.
  assert.deepEqual(tuples(stub.commands), [
    ['xdotool', ['getmouselocation', '--shell']],
    ['xdotool', ['click', '1']],
  ]);
});

test('a scoped input provider answers synthesis without host tool discovery', async () => {
  const inputCalls: Array<[string, string, string, string]> = [];
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    respond: () => {
      throw new Error('the injected input route owns synthesis');
    },
  });
  const provider = providerFor(stub, {
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

  await pressLinux(provider, 100, 200);

  assert.deepEqual(inputCalls, [['click', '100', '200', 'primary']]);
  assert.deepEqual(stub.commands, []);
});

test('two providers built on different hosts keep separate display decisions (#3794)', async () => {
  const x11 = x11Stub();
  await pressLinux(providerFor(x11), 1, 2);

  const wayland = waylandStub();
  await pressLinux(providerFor(wayland), 3, 4);

  assert.equal(
    tuples(x11.commands).some(
      ([cmd, args]) => cmd === 'xdotool' && args.includes('mousemove') && args.includes('--sync'),
    ),
    true,
  );
  assert.deepEqual(tuples(wayland.commands), [
    ['ydotool', ['mousemove', '--absolute', '-x', '3', '-y', '4']],
    ['ydotool', ['click', '0xC0']],
  ]);
});

test('the desktop provider translates semantic lifecycle calls to host tools', async () => {
  const stub = x11Stub(['wmctrl']);
  const provider = providerFor(stub);

  await provider.desktop.openTarget('https://example.test');
  await provider.desktop.openTarget('demo.desktop');
  await provider.desktop.closeApp('Demo');

  assert.deepEqual(tuples(stub.commands), [
    ['xdg-open', ['https://example.test']],
    ['xdg-open', ['demo.desktop']],
    ['wmctrl', ['-c', 'Demo']],
  ]);
  // The URL opens or fails the request; the .desktop fallback and the window close tolerate failure.
  assert.deepEqual(
    stub.commands.map((c) => c.allowFailure),
    [undefined, true, true],
  );
});

test('the desktop provider launches an app binary through the host detached launcher', async () => {
  const stub = x11Stub(['demo-app']);

  await providerFor(stub).desktop.openTarget('demo-app');

  assert.deepEqual(
    stub.launches.map((l) => [l.executable, [...l.args]]),
    [['demo-app', []]],
  );
  assert.deepEqual(stub.commands, []);
});

test('the desktop provider paces the request after a detached launch', async () => {
  const stub = x11Stub(['demo-app']);
  const paced: number[] = [];
  const provider = createLinuxToolProvider(stub.toolbox, {
    sleep: async (milliseconds) => {
      paced.push(milliseconds);
    },
  });

  await provider.desktop.openTarget('demo-app');

  assert.deepEqual(paced, [500]);
});

test('the desktop provider reports a launched app that ended badly', async () => {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: ['demo-app'],
    launchExit: () => ({ pid: 7, exitCode: 3 }),
  });

  await providerFor(stub).desktop.openTarget('demo-app');
  await flushMicrotasks();

  assert.deepEqual(stub.diagnostics, [
    { level: 'warn', phase: 'linux_app_launch', data: { app: 'demo-app', exitCode: 3 } },
  ]);
});

test('the desktop provider reports a launched app that could not start', async () => {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: ['demo-app'],
    launchExit: () => ({ pid: 0, error: 'spawn demo-app ENOENT' }),
  });

  await providerFor(stub).desktop.openTarget('demo-app');
  await flushMicrotasks();

  assert.deepEqual(stub.diagnostics, [
    {
      level: 'warn',
      phase: 'linux_app_launch',
      data: { app: 'demo-app', error: 'spawn demo-app ENOENT' },
    },
  ]);
});

test('the desktop provider reports nothing for a launched app that exits cleanly', async () => {
  const stub = createLinuxHostStub({
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    tools: ['demo-app'],
    launchExit: () => ({ pid: 7, exitCode: 0 }),
  });

  await providerFor(stub).desktop.openTarget('demo-app');
  await flushMicrotasks();

  assert.deepEqual(stub.diagnostics, []);
});

test('the desktop provider falls back to pkill when the host has no wmctrl', async () => {
  const stub = x11Stub([]);

  await providerFor(stub).desktop.closeApp('Demo');

  assert.deepEqual(tuples(stub.commands), [['pkill', ['-x', 'Demo']]]);
  assert.equal(stub.commands[0]?.allowFailure, true);
});

test('the screenshot provider translates capture to the tool the host reports', async () => {
  const stub = x11Stub(['scrot']);

  await providerFor(stub).screenshot!.capture('/tmp/screen.png');

  assert.deepEqual(tuples(stub.commands), [['scrot', ['/tmp/screen.png']]]);
});

/** Lets every promise the launch's exit already settled run, including its diagnostic. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
