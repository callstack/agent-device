import { expect, test, vi } from 'vitest';
import { withAppleToolProvider, createLocalAppleToolProvider } from '../core/tool-provider.ts';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import { ensureFoldHelperBinary } from './fold-helper-cache.ts';
import { sendSimulatorFoldPose } from './simulator-hid.ts';

vi.mock('./fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));

const selectedDuo = { ...IOS_SIMULATOR, id: 'selected-duo' };

test.each(['success', 'dispatch', 'cancel'] as const)(
  'HID route spawns the cached helper on the UDID and handles %s',
  async (outcome) => {
    const controller = new AbortController();
    if (outcome === 'cancel') {
      vi.mocked(ensureFoldHelperBinary).mockImplementationOnce(async () => {
        controller.abort(new Error('cancelled'));
        return { path: '/cache/fold-helper' };
      });
    }
    const dispatches: string[][] = [];
    await withAppleToolProvider(
      createLocalAppleToolProvider({
        runCommand: async (command, args, options) => {
          expect(command).toBe('xcrun');
          expect(options?.signal).toBe(controller.signal);
          dispatches.push([...args]);
          return { stdout: '', stderr: 'spawn detail', exitCode: outcome === 'dispatch' ? 1 : 0 };
        },
      }),
      async () => {
        const operation = sendSimulatorFoldPose(selectedDuo, 'half-open', controller.signal);
        if (outcome === 'success') await expect(operation).resolves.toBeUndefined();
        else if (outcome === 'cancel') await expect(operation).rejects.toThrow('cancelled');
        else
          await expect(operation).rejects.toMatchObject({
            code: 'COMMAND_FAILED',
            details: { reason: 'fold-hid-dispatch-failed', deviceId: 'selected-duo' },
          });
      },
    );
    expect(dispatches).toEqual(
      outcome === 'cancel'
        ? []
        : [['simctl', 'spawn', 'selected-duo', '/cache/fold-helper', 'half-open']],
    );
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
        dispatches++;
        expect(JSON.parse(args.at(-1)!)).toEqual(keyframes);
        expect(options?.timeoutMs).toBe(70000);
        expect(options?.kill).toEqual({ signal: 'SIGTERM', graceMs: 1000 });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    () => sendSimulatorFoldPose(selectedDuo, keyframes),
  );
  expect(dispatches).toBe(1);
});

// Transport-level only: this pins that a pose dispatch routes through runSimctlForDevice, which
// targets the UDID inside its scoped set. It is NOT end-to-end scoped-fold support — `appleFoldFact`
// refuses `unsupported-device-scope` at runtime admission before this dispatch is ever reached.
test('HID dispatch addresses the UDID inside its scoped simulator set', async () => {
  const dispatches: string[][] = [];
  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_command, args) => {
        dispatches.push([...args]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    () => sendSimulatorFoldPose({ ...selectedDuo, simulatorSetPath: '/tmp/scoped-set' }, 'closed'),
  );
  expect(dispatches).toEqual([
    ['simctl', '--set', '/tmp/scoped-set', 'spawn', 'selected-duo', '/cache/fold-helper', 'closed'],
  ]);
});
