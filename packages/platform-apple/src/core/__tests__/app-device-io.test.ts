import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { withAppleRunnerProvider } from '../../runner/index.ts';
import { IOS_SIMULATOR, TVOS_SIMULATOR } from '../../runner/__tests__/device-fixtures.ts';
import {
  recordingRunnerProvider,
  type RecordedRunnerCall,
} from '../../__tests__/recording-runner-provider.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { writeIosClipboardText } from '../app-device-io.ts';

vi.mock('../simulator.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../simulator.ts')>()),
  ensureBootedSimulator: async () => {},
}));

async function writeThroughBothRoutes(
  device: typeof IOS_SIMULATOR,
  text: string,
  signal = new AbortController().signal,
) {
  const runnerCalls: RecordedRunnerCall[] = [];
  const toolCalls: Array<{ args: string[]; stdin: unknown; signal: unknown }> = [];
  const tools = createLocalAppleToolProvider({
    runCommand: async (_cmd, args, options) => {
      toolCalls.push({ args, stdin: options?.stdin, signal: options?.signal });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  await withAppleToolProvider(tools, () =>
    withAppleRunnerProvider(recordingRunnerProvider(runnerCalls), { deviceId: device.id }, () =>
      writeIosClipboardText(device, text, { signal }),
    ),
  );
  return { runnerCommands: runnerCalls.map(({ command }) => command), toolCalls };
}

test('an iOS simulator clipboard write is the runner setting the pasteboard, not simctl', async () => {
  const { runnerCommands, toolCalls } = await writeThroughBothRoutes(IOS_SIMULATOR, 'code 246810');
  assert.equal(runnerCommands.length, 1);
  assert.equal(runnerCommands[0]?.command, 'pasteboardWrite');
  assert.equal(runnerCommands[0]?.text, 'code 246810');
  assert.deepEqual(toolCalls, []);
});

test('a tvOS simulator, whose runner has no pasteboard, writes through simctl pbcopy', async () => {
  const signal = new AbortController().signal;
  const { runnerCommands, toolCalls } = await writeThroughBothRoutes(
    TVOS_SIMULATOR,
    'code 246810',
    signal,
  );
  assert.deepEqual(runnerCommands, []);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0]?.args.slice(-2), ['pbcopy', TVOS_SIMULATOR.id]);
  assert.equal(toolCalls[0]?.stdin, 'code 246810');
  assert.equal(toolCalls[0]?.signal, signal);
});
