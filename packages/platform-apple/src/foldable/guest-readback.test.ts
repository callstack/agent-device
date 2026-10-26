import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));

import { withAppleToolProvider, createLocalAppleToolProvider } from '../core/tool-provider.ts';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import {
  parseHingeReading,
  readSimulatorHingeAngle,
  readSimulatorPanelPayload,
} from './guest-readback.ts';

const scopedDuo = { ...IOS_SIMULATOR, id: 'scoped-duo', simulatorSetPath: '/tmp/scoped-set' };

type Run = { stdout: string; stderr?: string; exitCode: number };

async function withHelperResult<T>(result: Run, run: () => Promise<T>) {
  const calls: { args: string[]; options: unknown }[] = [];
  const value = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (_command, args, options) => {
        calls.push({ args: [...args], options });
        return { stderr: '', ...result };
      },
    }),
    run,
  );
  return { value, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('reads one guest hinge sample through the scoped set without sending HID', async () => {
  const { value, calls } = await withHelperResult(
    { stdout: '{"version":1,"angleDegrees":130,"angleValid":true}\n', exitCode: 0 },
    () => readSimulatorHingeAngle(scopedDuo),
  );
  expect(value).toBe(130);
  expect(calls.map((call) => call.args)).toEqual([
    ['simctl', '--set', '/tmp/scoped-set', 'spawn', 'scoped-duo', '/cache/fold-helper', 'hinge'],
  ]);
  expect(calls[0]?.options).toMatchObject({ kill: { signal: 'SIGTERM', graceMs: 1000 } });
});

test.each([
  ['an invalid sample', '{"version":1,"angleDegrees":130,"angleValid":false}'],
  ['an angle past the open end stop', '{"version":1,"angleDegrees":181,"angleValid":true}'],
  ['a negative angle', '{"version":1,"angleDegrees":-1,"angleValid":true}'],
  ['another schema version', '{"version":2,"angleDegrees":130,"angleValid":true}'],
  ['a non-numeric angle', '{"version":1,"angleDegrees":"130","angleValid":true}'],
  ['no JSON at all', 'Angle: 130.0°'],
])('treats %s as no sample', (_label, stdout) => {
  expect(parseHingeReading(stdout)).toBeUndefined();
});

test('refuses a failed hinge read with the typed no-sample reason and the helper stderr', async () => {
  const { value } = await withHelperResult(
    { stdout: '', stderr: 'CMAngleManager is not available', exitCode: 3 },
    () => readSimulatorHingeAngle(scopedDuo).catch((error: unknown) => error),
  );
  expect(value).toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'fold-hinge-angle-no-sample',
      deviceId: 'scoped-duo',
      stderr: 'CMAngleManager is not available',
    }),
  });
});

test('ignores a sample printed by a helper that then failed', async () => {
  const { value } = await withHelperResult(
    { stdout: '{"version":1,"angleDegrees":0,"angleValid":true}', exitCode: 1 },
    () => readSimulatorHingeAngle(scopedDuo).catch((error: unknown) => error),
  );
  expect(value).toMatchObject({ details: { reason: 'fold-hinge-angle-no-sample' } });
});

test('wraps the guest panel table in the CoreDevice payload shape', async () => {
  const displays = [{ name: 'LCD', displayId: 1 }];
  const { value, calls } = await withHelperResult(
    { stdout: JSON.stringify({ version: 1, displays }), exitCode: 0 },
    () => readSimulatorPanelPayload(scopedDuo, { timeoutMs: 5000 }),
  );
  expect(value).toEqual({ result: { displays } });
  expect(calls[0]?.args.at(-1)).toBe('panels');
  expect(calls[0]?.options).toMatchObject({ timeoutMs: 5000 });
});

test('refuses an unreadable guest panel table with its typed reason', async () => {
  const { value } = await withHelperResult({ stdout: '{"version":1}', exitCode: 0 }, () =>
    readSimulatorPanelPayload(scopedDuo, { timeoutMs: 5000 }).catch((error: unknown) => error),
  );
  expect(value).toMatchObject({ details: { reason: 'fold-helper-panels-unreadable' } });
});

test('never spawns the helper for an already cancelled read', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('request cancelled', 'AbortError'));
  const { value, calls } = await withHelperResult({ stdout: '', exitCode: 0 }, () =>
    readSimulatorHingeAngle(scopedDuo, { signal: controller.signal }).catch(
      (error: unknown) => error,
    ),
  );
  expect(value).toMatchObject({ name: 'AbortError' });
  expect(calls).toEqual([]);
});
