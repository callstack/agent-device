import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));

import { withAppleToolProvider, createLocalAppleToolProvider } from '../core/tool-provider.ts';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import { ensureFoldHelperBinary } from './fold-helper-cache.ts';
import { openFoldHelper, parseHingeReading, type FoldHelper } from './fold-helper.ts';

const selectedDuo = { ...IOS_SIMULATOR, id: 'selected-duo' };
const scopedDuo = { ...IOS_SIMULATOR, id: 'scoped-duo', simulatorSetPath: '/tmp/scoped-set' };

type Run = { stdout: string; stderr?: string; exitCode: number };
type Call = { args: string[]; options: unknown };

/** Opens a helper on `device` and runs `use` against a tool provider that answers every exec. */
async function withHelper<T>(
  device: typeof IOS_SIMULATOR,
  result: Run,
  use: (helper: FoldHelper) => Promise<T>,
): Promise<{ value: T; calls: Call[] }> {
  const calls: Call[] = [];
  const value = await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (command, args, options) => {
        expect(command).toBe('xcrun');
        calls.push({ args: [...args], options });
        return { stderr: '', ...result };
      },
    }),
    async () => use(await openFoldHelper(device)),
  );
  return { value, calls };
}

const caught = (operation: Promise<unknown>) => operation.catch((error: unknown) => error);

beforeEach(() => {
  vi.clearAllMocks();
});

test('builds the helper once and reuses it for every mode', async () => {
  await withHelper(selectedDuo, { stdout: '', exitCode: 0 }, async (helper) => {
    await helper.setPose('closed');
    await caught(helper.readHingeAngle());
  });
  expect(ensureFoldHelperBinary).toHaveBeenCalledTimes(1);
});

test.each(['success', 'dispatch'] as const)(
  'setPose spawns set mode and handles %s',
  async (outcome) => {
    const { value, calls } = await withHelper(
      selectedDuo,
      { stdout: '', stderr: 'spawn detail', exitCode: outcome === 'dispatch' ? 1 : 0 },
      (helper) => caught(helper.setPose('half-open')),
    );
    expect(calls.map((call) => call.args)).toEqual([
      ['simctl', 'spawn', 'selected-duo', '/cache/fold-helper', 'set', 'half-open'],
    ]);
    if (outcome === 'success') expect(value).toBeUndefined();
    else
      expect(value).toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'fold-hid-dispatch-failed', deviceId: 'selected-duo' },
      });
  },
);

test('setPose streams all keyframes in one process with a duration-derived timeout', async () => {
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 60000, angle: 100 },
  ];
  const { calls } = await withHelper(selectedDuo, { stdout: '', exitCode: 0 }, (helper) =>
    helper.setPose(keyframes),
  );
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.args.at(-1)!)).toEqual(keyframes);
  expect(calls[0]!.options).toMatchObject({
    timeoutMs: 70000,
    kill: { signal: 'SIGTERM', graceMs: 1000 },
  });
});

test('every mode addresses the UDID inside its scoped simulator set', async () => {
  const { calls } = await withHelper(
    scopedDuo,
    { stdout: '{"version":1,"angleDegrees":130,"angleValid":true,"displays":[]}', exitCode: 0 },
    async (helper) => {
      await helper.setPose('closed');
      await helper.readHingeAngle();
      await helper.readPanelPayload({ timeoutMs: 5000 });
    },
  );
  const scoped = [
    'simctl',
    '--set',
    '/tmp/scoped-set',
    'spawn',
    'scoped-duo',
    '/cache/fold-helper',
  ];
  expect(calls.map((call) => call.args)).toEqual([
    [...scoped, 'set', 'closed'],
    [...scoped, 'hinge', '0'],
    [...scoped, 'panels'],
  ]);
});

test('reads one guest hinge sample without sending HID', async () => {
  const { value, calls } = await withHelper(
    scopedDuo,
    { stdout: '{"version":1,"angleDegrees":130,"angleValid":true}\n', exitCode: 0 },
    (helper) => helper.readHingeAngle(),
  );
  expect(value).toBe(130);
  expect(calls[0]?.options).toMatchObject({
    timeoutMs: 4000,
    kill: { signal: 'SIGTERM', graceMs: 1000 },
  });
});

test('passes the sampling window to the helper and extends the read deadline by it', async () => {
  const { calls } = await withHelper(
    scopedDuo,
    { stdout: '{"version":1,"angleDegrees":130,"angleValid":true}', exitCode: 0 },
    (helper) => helper.readHingeAngle({ windowMs: 1000 }),
  );
  expect(calls[0]?.args.slice(-2)).toEqual(['hinge', '1000']);
  expect(calls[0]?.options).toMatchObject({ timeoutMs: 5000 });
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

test.each([
  ['a failed read', { stdout: '', stderr: 'CMAngleManager is not available', exitCode: 3 }],
  [
    'a sample printed by a helper that then failed',
    { stdout: '{"version":1,"angleDegrees":0,"angleValid":true}', exitCode: 1 },
  ],
])('refuses %s with the typed no-sample reason', async (_label, result) => {
  const { value } = await withHelper(scopedDuo, result, (helper) =>
    caught(helper.readHingeAngle()),
  );
  expect(value).toMatchObject({
    code: 'COMMAND_FAILED',
    details: expect.objectContaining({
      reason: 'fold-hinge-angle-no-sample',
      deviceId: 'scoped-duo',
    }),
  });
});

test('wraps the guest panel table in the CoreDevice payload shape', async () => {
  const displays = [{ name: 'LCD', displayId: 1 }];
  const { value, calls } = await withHelper(
    scopedDuo,
    { stdout: JSON.stringify({ version: 1, displays }), exitCode: 0 },
    (helper) => helper.readPanelPayload({ timeoutMs: 5000 }),
  );
  expect(value).toEqual({ result: { displays } });
  expect(calls[0]?.options).toMatchObject({ timeoutMs: 5000 });
});

test.each([
  ['no table', { stdout: '{"version":1}', exitCode: 0 }],
  ['another schema version', { stdout: '{"version":2,"displays":[]}', exitCode: 0 }],
  ['a failed helper', { stdout: '', stderr: 'CADisplay is not available', exitCode: 3 }],
])('refuses a guest panel table with %s with its typed reason', async (_label, result) => {
  const { value } = await withHelper(scopedDuo, result, (helper) =>
    caught(helper.readPanelPayload({ timeoutMs: 5000 })),
  );
  expect(value).toMatchObject({ details: { reason: 'fold-helper-panels-unreadable' } });
});

test('never spawns the helper for an already cancelled read or dispatch', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('request cancelled', 'AbortError'));
  const { value, calls } = await withHelper(
    scopedDuo,
    { stdout: '', exitCode: 0 },
    async (helper) => [
      await caught(helper.readHingeAngle({ signal: controller.signal })),
      await caught(helper.setPose('open', controller.signal)),
    ],
  );
  expect(value).toMatchObject([{ name: 'AbortError' }, { name: 'AbortError' }]);
  expect(calls).toEqual([]);
});
