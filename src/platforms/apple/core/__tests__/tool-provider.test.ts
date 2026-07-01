import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createLocalAppleToolProvider,
  readApplePlistJson,
  runAppleToolCommand,
  runXcrun,
  withAppleToolProvider,
} from '../tool-provider.ts';

test('scoped Apple tool provider handles xcrun execution', async () => {
  const calls: Array<[string, string[]]> = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      calls.push([cmd, args]);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });

  const result = await withAppleToolProvider(
    provider,
    async () => await runXcrun(['simctl', 'launch', 'sim-1', 'com.example.app']),
  );

  assert.equal(result.stdout, 'ok');
  assert.deepEqual(calls, [['xcrun', ['simctl', 'launch', 'sim-1', 'com.example.app']]]);
});

test('scoped Apple tool provider prefers semantic simctl and devicectl hooks', async () => {
  const calls: Array<[string, string[]]> = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      calls.push([cmd, args]);
      return { exitCode: 0, stdout: 'generic', stderr: '' };
    },
    simctl: {
      run: async (args) => {
        calls.push(['simctl', args]);
        return { exitCode: 0, stdout: 'simctl', stderr: '' };
      },
    },
    devicectl: {
      run: async (args) => {
        calls.push(['devicectl', args]);
        return { exitCode: 0, stdout: 'devicectl', stderr: '' };
      },
    },
  });

  const simctlResult = await withAppleToolProvider(
    provider,
    async () => await runXcrun(['simctl', 'launch', 'sim-1', 'com.example.app']),
  );
  const devicectlResult = await withAppleToolProvider(
    provider,
    async () => await runXcrun(['devicectl', 'device', 'info', 'details']),
  );

  assert.equal(simctlResult.stdout, 'simctl');
  assert.equal(devicectlResult.stdout, 'devicectl');
  assert.deepEqual(calls, [
    ['simctl', ['launch', 'sim-1', 'com.example.app']],
    ['devicectl', ['device', 'info', 'details']],
  ]);
});

test('scoped Apple tool provider exposes plist JSON reads as semantic operation', async () => {
  const provider = createLocalAppleToolProvider({
    runCommand: async () => {
      throw new Error('generic command fallback should not be used for plist reads');
    },
    plist: {
      readJson: async (plistPath) => ({ plistPath, ok: true }),
    },
  });

  const result = await withAppleToolProvider(
    provider,
    async () => await readApplePlistJson('/tmp/Runner.xctestrun'),
  );

  assert.deepEqual(result, { plistPath: '/tmp/Runner.xctestrun', ok: true });
});

test('scoped Apple tool provider handles non-xcrun tool execution', async () => {
  const calls: Array<[string, string[]]> = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      calls.push([cmd, args]);
      return { exitCode: 0, stdout: 'focused', stderr: '' };
    },
  });

  const result = await withAppleToolProvider(
    provider,
    async () => await runAppleToolCommand('open', ['-a', 'Simulator']),
  );

  assert.equal(result.stdout, 'focused');
  assert.deepEqual(calls, [['open', ['-a', 'Simulator']]]);
});

test('local Apple tool provider exposes macOS host operations as semantic methods', async () => {
  const calls: Array<[string, string[], string | undefined]> = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args, options) => {
      calls.push([cmd, args, typeof options?.stdin === 'string' ? options.stdin : undefined]);
      if (cmd === 'pbpaste') {
        return { exitCode: 0, stdout: 'copied\r\n', stderr: '' };
      }
      if (cmd === 'osascript' && args.join(' ').includes('get dark mode')) {
        return { exitCode: 0, stdout: 'false\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const host = provider.macosHost;
  assert.ok(host);

  await host.openBundle('com.example.demo', 'demo://open');
  await host.openTarget('https://example.test');
  await host.writeClipboard('secret');
  const clipboard = await host.readClipboard();
  const darkMode = await host.readDarkMode();
  await host.setDarkMode(true);

  assert.equal(clipboard, 'copied');
  assert.equal(darkMode, false);
  assert.deepEqual(calls, [
    ['open', ['-b', 'com.example.demo', 'demo://open'], undefined],
    ['open', ['https://example.test'], undefined],
    ['pbcopy', [], 'secret'],
    ['pbpaste', [], undefined],
    [
      'osascript',
      ['-e', 'tell application "System Events" to tell appearance preferences to get dark mode'],
      undefined,
    ],
    [
      'osascript',
      [
        '-e',
        'tell application "System Events" to tell appearance preferences to set dark mode to true',
      ],
      undefined,
    ],
  ]);
});
