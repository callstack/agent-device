import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { withAppleToolProvider, createLocalAppleToolProvider } from '../core/tool-provider.ts';
import { sendSimulatorFoldPose } from './simulator-hid.ts';

test.each(['success', 'build', 'dispatch', 'cancel'] as const)(
  'HID route targets the UDID, cleans temporary artifacts, and handles %s',
  async (failure) => {
    const calls: string[][] = [];
    const controller = new AbortController();
    let binary = '';
    await withAppleToolProvider(
      createLocalAppleToolProvider({
        runCommand: async (command, args, options) => {
          expect(command).toBe('xcrun');
          expect(options?.signal).toBe(controller.signal);
          expect(options?.timeoutMs).toBeGreaterThan(0);
          calls.push(args);
          if (args.includes('clang')) {
            binary = args.at(-1)!;
            expect(existsSync(path.dirname(binary))).toBe(true);
            expect(existsSync(args[args.indexOf('-o') - 1]!)).toBe(true);
            if (failure === 'cancel') controller.abort(new Error('cancelled'));
            return { stdout: '', stderr: 'compiler detail', exitCode: failure === 'build' ? 1 : 0 };
          }
          expect(args).toEqual(['simctl', 'spawn', 'selected-duo', binary, 'half-open']);
          return { stdout: '', stderr: 'spawn detail', exitCode: failure === 'dispatch' ? 1 : 0 };
        },
      }),
      async () => {
        const operation = sendSimulatorFoldPose('selected-duo', 'half-open', controller.signal);
        if (failure === 'success') await expect(operation).resolves.toBeUndefined();
        else if (failure === 'cancel') await expect(operation).rejects.toThrow('cancelled');
        else
          await expect(operation).rejects.toMatchObject({
            code: 'COMMAND_FAILED',
            details: {
              reason: failure === 'build' ? 'fold-helper-build-failed' : 'fold-hid-dispatch-failed',
            },
          });
      },
    );
    expect(calls).toHaveLength(failure === 'build' || failure === 'cancel' ? 1 : 2);
    expect(existsSync(path.dirname(binary))).toBe(false);
  },
);

test('streams all keyframes in one process with a duration-derived timeout', async () => {
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 60000, angle: 100 },
  ];
  let dispatches = 0;
  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_command, args, options) => {
        if (args[0] === 'simctl') {
          dispatches++;
          expect(JSON.parse(args.at(-1)!)).toEqual(keyframes);
          expect(options?.timeoutMs).toBe(70000);
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    () => sendSimulatorFoldPose('duo', keyframes),
  );
  expect(dispatches).toBe(1);
});
