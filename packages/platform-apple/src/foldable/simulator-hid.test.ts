import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { withAppleToolProvider, createLocalAppleToolProvider } from '../core/tool-provider.ts';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import { sendSimulatorFoldPose } from './simulator-hid.ts';

const selectedDuo = { ...IOS_SIMULATOR, id: 'selected-duo' };

type RecordedCall = Readonly<{ command: string; args: readonly string[] }>;

type ExecResponse = { stdout: string; stderr: string; exitCode: number };

/** The fixed response for the host toolchain probes `sendSimulatorFoldPose` reads, or `undefined` for `xcrun`. */
function toolchainProbeResponse(
  command: string,
  args: readonly string[],
): ExecResponse | undefined {
  if (command === 'xcodebuild')
    return { stdout: 'Xcode 16.4\nBuild version 16F6', stderr: '', exitCode: 0 };
  if (command === 'sw_vers') {
    return { stdout: args.includes('-buildVersion') ? '24G90' : '15.6', stderr: '', exitCode: 0 };
  }
  if (command === 'uname') return { stdout: 'arm64', stderr: '', exitCode: 0 };
  return undefined;
}

async function respondToClang(
  args: readonly string[],
  onClang?: (args: readonly string[]) => ExecResponse | undefined,
): Promise<ExecResponse> {
  const outcome = onClang?.(args);
  // The build cache checks the binary actually landed at `-o`'s path, so every clang response
  // short of a compiler failure has to leave that file behind.
  if (!outcome || outcome.exitCode === 0) {
    const outputPath = args.at(-1)!;
    await writeFile(outputPath, 'fold-helper-binary');
  }
  return outcome ?? { stdout: '', stderr: '', exitCode: 0 };
}

/**
 * Answers every exec `sendSimulatorFoldPose` can make: the toolchain probes the fold-helper cache
 * reads, the fold-helper clang build, and the `simctl spawn` dispatch. `onClang`/`onSpawn` override
 * the default success behavior for one of the two `xcrun` calls.
 */
function createFoldToolMock(
  calls: RecordedCall[],
  overrides: {
    onClang?: (args: readonly string[]) => ExecResponse | undefined;
    onSpawn?: (args: readonly string[]) => ExecResponse;
  } = {},
) {
  return async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const probeResponse = toolchainProbeResponse(command, args);
    if (probeResponse) return probeResponse;
    expect(command).toBe('xcrun');
    if (args.includes('clang')) return respondToClang(args, overrides.onClang);
    if (overrides.onSpawn) return overrides.onSpawn(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

function clangArgs(calls: readonly RecordedCall[]): readonly string[] {
  return calls.find((call) => call.args.includes('clang'))!.args;
}

test('the runtime clang build never uses -Werror', async () => {
  const cacheRoot = await mkdtempForTest('agent-device-fold-cache-');
  const calls: RecordedCall[] = [];
  await withAppleToolProvider(
    createLocalAppleToolProvider({ runCommand: createFoldToolMock(calls) }),
    () => sendSimulatorFoldPose(selectedDuo, 'half-open', undefined, { cacheRoot }),
  );
  expect(clangArgs(calls)).not.toContain('-Werror');
});

test('a second call reuses the cached fold helper and does not invoke clang again', async () => {
  const cacheRoot = await mkdtempForTest('agent-device-fold-cache-hit-');
  const calls: RecordedCall[] = [];
  const runCommand = createFoldToolMock(calls);

  await withAppleToolProvider(createLocalAppleToolProvider({ runCommand }), () =>
    sendSimulatorFoldPose(selectedDuo, 'half-open', undefined, { cacheRoot }),
  );
  const clangCallsAfterFirst = calls.filter((call) => call.args.includes('clang')).length;
  expect(clangCallsAfterFirst).toBe(1);

  await withAppleToolProvider(createLocalAppleToolProvider({ runCommand }), () =>
    sendSimulatorFoldPose(selectedDuo, 'open', undefined, { cacheRoot }),
  );

  expect(calls.filter((call) => call.args.includes('clang'))).toHaveLength(1);
  expect(calls.filter((call) => call.args.includes('spawn'))).toHaveLength(2);
});

test.each(['build', 'dispatch', 'cancel'] as const)(
  'HID route targets the UDID and handles %s',
  async (failure) => {
    const cacheRoot = await mkdtempForTest(`agent-device-fold-cache-${failure}-`);
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    const runCommand = createFoldToolMock(calls, {
      onClang: () => {
        if (failure === 'build') return { stdout: '', stderr: 'compiler detail', exitCode: 1 };
        if (failure === 'cancel') controller.abort(new Error('cancelled'));
        return undefined;
      },
      onSpawn: (args) => {
        expect(args.slice(0, 3)).toEqual(['simctl', 'spawn', 'selected-duo']);
        expect(args.at(-2)).toMatch(/fold-helper$/);
        return { stdout: '', stderr: 'spawn detail', exitCode: failure === 'dispatch' ? 1 : 0 };
      },
    });
    await withAppleToolProvider(createLocalAppleToolProvider({ runCommand }), async () => {
      const operation = sendSimulatorFoldPose(selectedDuo, 'half-open', controller.signal, {
        cacheRoot,
      });
      if (failure === 'build') {
        await expect(operation).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { reason: 'fold-helper-build-failed' },
        });
      } else if (failure === 'dispatch') {
        await expect(operation).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { reason: 'fold-hid-dispatch-failed' },
        });
      } else {
        await expect(operation).rejects.toThrow(/cancelled/);
      }
    });
  },
);

test('streams all keyframes in one process with a duration-derived timeout', async () => {
  const cacheRoot = await mkdtempForTest('agent-device-fold-cache-keyframes-');
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 60000, angle: 100 },
  ];
  const calls: RecordedCall[] = [];
  const baseMock = createFoldToolMock(calls);
  let dispatchTimeoutMs: number | undefined;
  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (command, args, options) => {
        if (args[0] === 'simctl') {
          calls.push({ command, args });
          expect(JSON.parse(args.at(-1)!)).toEqual(keyframes);
          dispatchTimeoutMs = options?.timeoutMs;
          expect(options?.kill).toEqual({ signal: 'SIGTERM', graceMs: 1000 });
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return await baseMock(command, args);
      },
    }),
    () => sendSimulatorFoldPose(selectedDuo, keyframes, undefined, { cacheRoot }),
  );
  expect(dispatchTimeoutMs).toBe(70000);
  expect(calls.filter((call) => call.args[0] === 'simctl')).toHaveLength(1);
});

test('HID dispatch addresses the UDID inside its scoped simulator set', async () => {
  const cacheRoot = await mkdtempForTest('agent-device-fold-cache-scoped-');
  const calls: RecordedCall[] = [];
  await withAppleToolProvider(
    createLocalAppleToolProvider({ runCommand: createFoldToolMock(calls) }),
    () =>
      sendSimulatorFoldPose(
        { ...selectedDuo, simulatorSetPath: '/tmp/scoped-set' },
        'closed',
        undefined,
        { cacheRoot },
      ),
  );
  const dispatch = calls.find((call) => call.args[0] === 'simctl')!;
  expect(dispatch.args.slice(0, 5)).toEqual([
    'simctl',
    '--set',
    '/tmp/scoped-set',
    'spawn',
    'selected-duo',
  ]);
  expect(dispatch.args.at(-2)).toMatch(/fold-helper$/);
  expect(dispatch.args.at(-1)).toBe('closed');
});
