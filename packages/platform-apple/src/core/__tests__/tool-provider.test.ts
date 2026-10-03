import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createLocalAppleToolProvider,
  readApplePlistJson,
  resolveAppleToolProvider,
  runAppleToolCommand,
  runXcrun,
  simctlCommand,
  withAppleToolProvider,
  type ScopedSimctlCommand,
} from '../tool-provider.ts';
import { buildSimctlArgsForDevice, scopeSimctlArgsForDevice } from '../simctl.ts';
import type { AppleToolRequest } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17',
  kind: 'simulator',
  target: 'mobile',
};
const LAUNCH_COMMAND = buildSimctlArgsForDevice(IOS_SIMULATOR, [
  'launch',
  'sim-1',
  'com.example.app',
]);

function compileTimeScopedSimctlProof(request: AppleToolRequest, argv: string[]): void {
  // @ts-expect-error Raw simctl argv cannot reach the provider; scope it in core/simctl.ts.
  void resolveAppleToolProvider().simctl.run(['spawn', 'sim-1', 'bridge']);
  // @ts-expect-error A literal simctl argv is not a ScopedSimctlCommand.
  void runXcrun(['simctl', 'spawn', 'sim-1', 'bridge']);
  const tool = 'simctl';
  // @ts-expect-error A tool name held in a const keeps its literal type, so it is refused too.
  void runXcrun([tool, 'spawn', 'sim-1', 'bridge']);
  const widenedTool: string = 'simctl';
  // @ts-expect-error runXcrun names every other tool it runs, so a string tool name is refused.
  void runXcrun([widenedTool, 'spawn', 'sim-1', 'bridge']);
  // @ts-expect-error An argv typed string[] may start with simctl, so it is refused.
  void runXcrun(argv);
  // @ts-expect-error Copying a scoped command drops its brand.
  void runXcrun([...LAUNCH_COMMAND]);
  // @ts-expect-error A request whose tool may be simctl goes to the simctl provider with its scoped args.
  void runXcrun([request.tool, ...request.args]);
  // @ts-expect-error A hand-built simctl argv is not a ScopedSimctlCommand.
  const handBuilt: ScopedSimctlCommand = ['simctl', 'boot', 'sim-1'];
  void handBuilt;
  // @ts-expect-error simctlCommand takes set-scoped arguments, never a raw argv.
  void simctlCommand(['boot', 'sim-1']);
}
void compileTimeScopedSimctlProof;

test('scoped Apple tool provider handles xcrun execution', async () => {
  const calls: Array<[string, string[]]> = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      calls.push([cmd, args]);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });

  const result = await withAppleToolProvider(provider, async () => await runXcrun(LAUNCH_COMMAND));

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
        calls.push(['simctl', [...args]]);
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
    async () => await runXcrun(LAUNCH_COMMAND),
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

test('simctlCommand prefixes set-scoped arguments with the tool name and freezes the argv', () => {
  const command = simctlCommand(
    scopeSimctlArgsForDevice({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant/simulator-set' }, [
      'boot',
      'sim-1',
    ]),
  );

  assert.deepEqual(command, ['simctl', '--set', '/tmp/tenant/simulator-set', 'boot', 'sim-1']);
  assert.ok(Object.isFrozen(command));
});

test('runXcrun hands a scoped simctl command to the simctl provider with its set intact', async () => {
  const received: Array<readonly string[]> = [];
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args) => {
        received.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  const command = buildSimctlArgsForDevice(
    { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant/simulator-set' },
    ['boot', 'sim-1'],
  );

  await withAppleToolProvider(provider, async () => await runXcrun(command));

  assert.deepEqual(received, [['--set', '/tmp/tenant/simulator-set', 'boot', 'sim-1']]);
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
