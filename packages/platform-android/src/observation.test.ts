import { expect, test, vi } from 'vitest';
import type { AndroidObservationHost } from '@agent-device/contracts/android-observation';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { createAndroidObservationAdapter } from './observation.ts';

vi.mock('./automation-helper.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automation-helper.ts')>()),
  runAndroidAutomationHelper: vi.fn(async () => undefined),
}));

const device = {
  platform: 'android',
  target: 'mobile',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} satisfies DeviceInfo;

function hostFor(stdoutByCommand: ReadonlyMap<string, string>): AndroidObservationHost {
  return {
    runAdb: vi.fn(async (_device, args) => ({
      exitCode: 0,
      stdout: stdoutByCommand.get(args.join(' ')) ?? '',
      stderr: '',
    })),
    readSnapshotNodes: vi.fn(async () => []),
    openApp: vi.fn(async () => {}),
  };
}

test('answers focus and blocking-dialog questions from one observation-bound dump', async () => {
  const host = hostFor(
    new Map([
      ['shell dumpsys window windows', 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}'],
    ]),
  );
  const observer = createAndroidObservationAdapter(host);

  await expect(
    observer.readAppFocus(device, 'com.example.app', { requireNoBlockingDialog: true }),
  ).resolves.toBe(true);
  expect(host.runAdb).toHaveBeenCalledTimes(1);
});

test('classifies an app-owned ANR without exposing dump mechanics to the daemon', async () => {
  const host = hostFor(
    new Map([
      [
        'shell dumpsys window windows',
        'mCurrentFocus=Window{1 u0 Application Not Responding: com.example.app}',
      ],
    ]),
  );

  await expect(createAndroidObservationAdapter(host).readBlockingDialog(device)).resolves.toEqual({
    status: 'dialog',
    focus: {
      package: 'com.example.app',
      focusedWindow: 'Application Not Responding: com.example.app',
      raw: 'mCurrentFocus=Window{1 u0 Application Not Responding: com.example.app}',
    },
  });
});

test('owns touch rounding and screen-size parsing behind raw host commands', async () => {
  const host = hostFor(new Map([['shell wm size', 'Physical size: 1080x2400']]));
  const observer = createAndroidObservationAdapter(host);

  await expect(observer.readScreenSize(device)).resolves.toEqual({ width: 1080, height: 2400 });
  await observer.tap(device, 12.6, 42.2);
  expect(host.runAdb).toHaveBeenLastCalledWith(device, ['shell', 'input', 'tap', '13', '42'], {
    allowFailure: true,
  });
});

test('a transient empty dump never demotes a variant that previously answered', async () => {
  const calls: string[] = [];
  let primaryReads = 0;
  const host: AndroidObservationHost = {
    ...hostFor(new Map()),
    runAdb: vi.fn(async (_device, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'shell dumpsys window windows') primaryReads += 1;
      return {
        exitCode: 0,
        stdout:
          primaryReads === 2 && key === 'shell dumpsys window windows'
            ? ''
            : 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}',
        stderr: '',
      };
    }),
  };
  const observer = createAndroidObservationAdapter(host);
  const transientDevice = { ...device, id: 'emulator-transient' };

  await observer.readAppState(transientDevice);
  await observer.readAppState(transientDevice);
  const thirdReadStart = calls.length;
  await observer.readAppState(transientDevice);

  expect(calls[thirdReadStart]).toBe('shell dumpsys window windows');
});

function timedOutAdb(args: readonly string[], timeoutMs: number): AppError {
  return new AppError('COMMAND_FAILED', 'adb timed out', { cmd: 'adb', args, timeoutMs });
}

type Observer = ReturnType<typeof createAndroidObservationAdapter>;

const QUESTIONS = [
  {
    question: 'foreground',
    ask: (observer: Observer, target: DeviceInfo) => observer.readAppState(target),
    unanswered: {},
  },
  {
    question: 'blocking dialog',
    ask: (observer: Observer, target: DeviceInfo) => observer.readBlockingDialog(target),
    unanswered: { status: 'unknown' },
  },
] as const;

/**
 * A host whose every dump answers without a focus line after `spendMs(timeoutMs)` of a virtual
 * clock, optionally timing out instead, so an observation walks every variant it is allowed to.
 */
function slowHost(params: { spendMs: (timeoutMs: number) => number; timeOut?: boolean }): {
  host: AndroidObservationHost;
  timeouts: number[];
  advance: (ms: number) => void;
  restore: () => void;
} {
  const originMs = Date.now();
  let elapsedMs = 0;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => originMs + elapsedMs);
  const timeouts: number[] = [];
  const host: AndroidObservationHost = {
    ...hostFor(new Map()),
    runAdb: vi.fn(async (_device, args, options) => {
      const timeoutMs = options?.timeoutMs ?? Number.POSITIVE_INFINITY;
      timeouts.push(timeoutMs);
      elapsedMs += params.spendMs(timeoutMs);
      if (params.timeOut) throw timedOutAdb(args, timeoutMs);
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  };
  return {
    host,
    timeouts,
    advance: (ms) => {
      elapsedMs += ms;
    },
    restore: () => now.mockRestore(),
  };
}

test('bounds every dump read the foreground question makes', async () => {
  const { host, timeouts, restore } = slowHost({ spendMs: () => 0 });
  try {
    await createAndroidObservationAdapter(host).readAppState({ ...device, id: 'emulator-bounded' });
  } finally {
    restore();
  }

  expect(vi.mocked(host.runAdb).mock.calls.map(([, args]) => args.join(' '))).toEqual([
    'shell dumpsys window windows',
    'shell dumpsys window',
    'shell dumpsys activity activities',
    'shell dumpsys activity',
  ]);
  for (const timeoutMs of timeouts) expect(Number.isFinite(timeoutMs) && timeoutMs > 0).toBe(true);
});

test('later variants receive only what the earlier reads left of one observation budget', async () => {
  const { host, timeouts, restore } = slowHost({
    spendMs: (timeoutMs) => Math.floor(timeoutMs / 2),
  });
  try {
    await createAndroidObservationAdapter(host).readAppState({ ...device, id: 'emulator-slow' });
  } finally {
    restore();
  }

  const budgetMs = timeouts[0]!;
  expect(timeouts.length).toBeGreaterThan(1);
  for (let index = 1; index < timeouts.length; index += 1) {
    expect(timeouts[index]).toBe(timeouts[index - 1]! - Math.floor(timeouts[index - 1]! / 2));
  }
  const spentMs = timeouts.reduce((sum, timeoutMs) => sum + Math.floor(timeoutMs / 2), 0);
  expect(spentMs).toBeLessThanOrEqual(budgetMs);
});

test.each(
  QUESTIONS.flatMap((entry) => [
    { ...entry, ending: 'times out', timeOut: true },
    { ...entry, ending: 'answers at its bound', timeOut: false },
  ]),
)(
  'a $question read that $ending spends the observation budget and leaves it unanswered',
  async ({ question, ask, unanswered, timeOut }) => {
    const { host, restore } = slowHost({ spendMs: (timeoutMs) => timeoutMs, timeOut });
    try {
      await expect(
        ask(createAndroidObservationAdapter(host), { ...device, id: `emulator-${question}` }),
      ).resolves.toEqual(unanswered);
    } finally {
      restore();
    }
    expect(host.runAdb).toHaveBeenCalledTimes(1);
  },
);

test('a dump that fails without timing out still fails the observation', async () => {
  const failure = new AppError('COMMAND_FAILED', 'adb: device offline', { cmd: 'adb' });
  const host: AndroidObservationHost = {
    ...hostFor(new Map()),
    runAdb: vi.fn(async () => {
      throw failure;
    }),
  };

  await expect(
    createAndroidObservationAdapter(host).readAppState({ ...device, id: 'emulator-offline' }),
  ).rejects.toBe(failure);
});

test('the helper focus call before the first dump does not spend the dump budget', async () => {
  const unhurried = slowHost({ spendMs: () => 0 });
  try {
    await createAndroidObservationAdapter(unhurried.host).readBlockingDialog({
      ...device,
      id: 'emulator-focus-fast',
    });
  } finally {
    unhurried.restore();
  }

  const slowFocus = slowHost({ spendMs: () => 0 });
  const focusCostMs = Math.floor(unhurried.timeouts[0]! / 2);
  vi.mocked(runAndroidAutomationHelper).mockImplementationOnce(async () => {
    slowFocus.advance(focusCostMs);
    return undefined;
  });
  try {
    await createAndroidObservationAdapter(slowFocus.host).readBlockingDialog({
      ...device,
      id: 'emulator-focus-slow',
    });
  } finally {
    slowFocus.restore();
  }

  expect(slowFocus.timeouts[0]).toBe(unhurried.timeouts[0]);
});

test('a read that starts with the budget nearly spent never passes a non-positive timeout', async () => {
  // Each clock read advances 1 ms, so two reads of one deadline disagree by one millisecond.
  const originMs = Date.now();
  let elapsedMs = 0;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => {
    elapsedMs += 1;
    return originMs + elapsedMs;
  });
  const timeouts: number[] = [];
  const host: AndroidObservationHost = {
    ...hostFor(new Map()),
    runAdb: vi.fn(async (_device, _args, options) => {
      const timeoutMs = options?.timeoutMs ?? Number.POSITIVE_INFINITY;
      timeouts.push(timeoutMs);
      elapsedMs += timeoutMs - 2;
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  };
  try {
    await createAndroidObservationAdapter(host).readAppState({
      ...device,
      id: 'emulator-rollover',
    });
  } finally {
    now.mockRestore();
  }

  expect(timeouts.length).toBeGreaterThan(1);
  for (const timeoutMs of timeouts) expect(timeoutMs).toBeGreaterThan(0);
});
