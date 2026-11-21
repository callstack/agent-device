import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import type { HarmonyHdcRunner } from '../hdc.ts';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createHarmonyHdcRunnerStub, createHarmonyHostStub } from '../toolbox.fixtures.ts';

const { invalidateHarmonyGestureViewport } = vi.hoisted(() => ({
  invalidateHarmonyGestureViewport: vi.fn(),
}));

vi.mock('../snapshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snapshot.ts')>()),
  invalidateHarmonyGestureViewport,
}));

import {
  HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS,
  closeHarmonyApp,
  listHarmonyApps,
  parseHarmonyIsSystemApp,
  openHarmonyApp,
  parseHarmonyBundleList,
  parseHarmonyLaunchTarget,
  pollHarmonyOpenForeground,
  resolveHarmonyArchiveBundleName,
  verifyHarmonyOpenForeground,
} from '../app-lifecycle.ts';

const mockRunShell = vi.fn<HarmonyHdcRunner['runShell']>();
const foregroundHdc = { ...createHarmonyHdcRunnerStub(), runShell: mockRunShell };

const DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  vi.useRealTimers();
  invalidateHarmonyGestureViewport.mockReset();
  mockRunShell.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('parseHarmonyBundleList reads package lines from bm dump output', () => {
  assert.deepEqual(
    parseHarmonyBundleList('ID: 100:\n\tcom.example.application\n\tcom.huawei.hmos.settings\n'),
    ['com.example.application', 'com.huawei.hmos.settings'],
  );
});

test('parseHarmonyLaunchTarget reads the main ability and module from bm dump output', () => {
  assert.deepEqual(
    parseHarmonyLaunchTarget(
      `com.example.application:\n${JSON.stringify({
        hapModuleInfos: [
          { moduleName: 'entry', mainElementName: 'EntryAbility' },
          { moduleName: 'feature' },
        ],
      })}`,
    ),
    { ability: 'EntryAbility', module: 'entry' },
  );
  assert.equal(parseHarmonyLaunchTarget('bundle not found'), undefined);
});

test('parseHarmonyIsSystemApp reads Bundle Manager application metadata', () => {
  assert.equal(
    parseHarmonyIsSystemApp(JSON.stringify({ applicationInfo: { isSystemApp: true } })),
    true,
  );
  assert.equal(parseHarmonyIsSystemApp(JSON.stringify({ appInfo: { isSystemApp: false } })), false);
  assert.equal(parseHarmonyIsSystemApp('bundle metadata unavailable'), undefined);
});

test('resolveHarmonyArchiveBundleName reads module metadata through unzip on the host', async () => {
  const stub = createHarmonyHostStub();
  stub.answer({
    stdout: JSON.stringify({ app: { bundleName: 'com.example.application' } }),
  });

  assert.equal(
    await resolveHarmonyArchiveBundleName(stub.toolbox.commands, '/tmp/example.hap'),
    'com.example.application',
  );
  assert.deepEqual(stub.commands[0], {
    executable: 'unzip',
    args: ['-p', '/tmp/example.hap', 'module.json'],
    env: { PATH: '/usr/bin' },
    timeoutMs: 15_000,
    allowFailure: true,
    signal: undefined,
  });
});

test('resolveHarmonyArchiveBundleName forwards the binding signal to in-flight unzip', async () => {
  const controller = new AbortController();
  const stub = createHarmonyHostStub();

  const pending = resolveHarmonyArchiveBundleName(
    stub.toolbox.commands,
    '/tmp/example.hap',
    controller.signal,
  );
  await pending;

  assert.equal(stub.commands[0]?.signal, controller.signal);
});

test('HarmonyOS lifecycle commands use HDC bundle and ability primitives', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\n' },
    { stdout: 'start ability successfully' },
    { stdout: '' },
  ]);

  assert.deepEqual(await listHarmonyApps(hdc, DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  await openHarmonyApp(hdc, DEVICE, 'com.example.application', { activity: 'EntryAbility' });
  await closeHarmonyApp(hdc, DEVICE, 'com.example.application');

  assert.deepEqual(
    hdc.calls.map((call) => [call.kind, call.target, call.args]),
    [
      ['runShell', 'harmony-1', ['bm', 'dump', '-a']],
      [
        'runShell',
        'harmony-1',
        ['aa', 'start', '-a', 'EntryAbility', '-b', 'com.example.application'],
      ],
      ['runShell', 'harmony-1', ['aa', 'force-stop', 'com.example.application']],
    ],
  );
  assert.deepEqual(invalidateHarmonyGestureViewport.mock.calls, [[DEVICE], [DEVICE]]);
});

test('openHarmonyApp refuses an ability name outside the module grammar before any hdc call', async () => {
  const hdc = createHarmonyHdcRunnerStub();
  for (const activity of ['Entry$(id)', 'Entry;reboot', 'Entry Ability', '1Entry', 'Entry"x', '']) {
    await assert.rejects(
      () => openHarmonyApp(hdc, DEVICE, 'com.example.application', { activity }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.details?.reason === 'invalid-harmony-ability-name' &&
        error.details?.ability === activity,
    );
  }
  assert.equal(hdc.calls.length, 0);
});

test('HarmonyOS app listing filters user-installed bundles through Bundle Manager metadata', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\ncom.ohos.settings\n' },
    { stdout: JSON.stringify({ applicationInfo: { isSystemApp: false } }) },
    { stdout: JSON.stringify({ applicationInfo: { isSystemApp: true } }) },
  ]);

  assert.deepEqual(await listHarmonyApps(hdc, DEVICE, 'user-installed'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  assert.deepEqual(
    hdc.calls.map((call) => call.args),
    [
      ['bm', 'dump', '-a'],
      ['bm', 'dump', '-n', 'com.example.application'],
      ['bm', 'dump', '-n', 'com.ohos.settings'],
    ],
  );
});

test('HarmonyOS app listing preserves the complete inventory for the all filter', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\ncom.ohos.settings\n' },
  ]);

  assert.deepEqual(await listHarmonyApps(hdc, DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
    { package: 'com.ohos.settings', name: 'settings' },
  ]);
  assert.deepEqual(
    hdc.calls.map((call) => call.args),
    [['bm', 'dump', '-a']],
  );
});

test('HarmonyOS user-installed app listing rejects bundles without a system-app classification', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    { stdout: 'com.example.application\n' },
    { stdout: JSON.stringify({ applicationInfo: {} }) },
  ]);

  await assert.rejects(
    () => listHarmonyApps(hdc, DEVICE, 'user-installed'),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.details?.hint ?? '', /use apps --all to list all bundles/i);
      return true;
    },
  );
});

test('HarmonyOS user-installed app listing bounds metadata work and cancels queued work on failure', async () => {
  const packages = Array.from({ length: 6 }, (_, index) => `com.example.app${index + 1}`);
  const hdc = createHarmonyHdcRunnerStub();
  const metadataSignals: AbortSignal[] = [];
  let metadataCalls = 0;
  hdc.runShell = async (_device, words, options) => {
    if (words.at(-1) === '-a') {
      return { stdout: `${packages.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    metadataCalls += 1;
    const bundle = words.at(-1);
    if (bundle === 'com.example.app4') {
      return { stdout: JSON.stringify({ applicationInfo: {} }), stderr: '', exitCode: 0 };
    }
    const signal = options?.signal;
    assert(signal);
    metadataSignals.push(signal);
    return await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  };

  await assert.rejects(
    () => listHarmonyApps(hdc, DEVICE, 'user-installed'),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.match(
        error.message,
        /could not determine whether com\.example\.app4 is a system application/i,
      );
      assert.match(error.details?.hint ?? '', /use apps --all/i);
      return true;
    },
  );

  assert.equal(metadataCalls, 4);
  assert.equal(metadataSignals.length, 3);
  assert(metadataSignals.every((signal) => signal.aborted));
});

test('HarmonyOS user-installed app listing aborts all metadata reads at its aggregate deadline', async () => {
  vi.useFakeTimers();
  const packages = Array.from({ length: 6 }, (_, index) => `com.example.app${index + 1}`);
  const hdc = createHarmonyHdcRunnerStub();
  const metadataSignals: AbortSignal[] = [];
  let metadataCalls = 0;
  hdc.runShell = async (_device, _words, options) => {
    metadataCalls += 1;
    const signal = options?.signal;
    assert(signal);
    metadataSignals.push(signal);
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  };
  // The bundle list itself is the first shell read; answer it and let the metadata reads hang.
  const originalRunShell = hdc.runShell;
  let first = true;
  hdc.runShell = async (device, words, options) => {
    if (first && words.at(-1) === '-a') {
      first = false;
      return { stdout: `${packages.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    return await originalRunShell(device, words, options);
  };

  const listing = listHarmonyApps(hdc, DEVICE, 'user-installed');
  const listingError = listing.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(metadataCalls, 4);

  await vi.advanceTimersByTimeAsync(60_000);
  const error = await listingError;
  assert(error instanceof AppError);
  assert.match(error.message, /timed out while classifying HarmonyOS application inventory/i);
  assert.match(error.details?.hint ?? '', /use apps --all/i);
  assert.equal(metadataCalls, 4);
  assert.equal(metadataSignals.length, 4);
  assert(metadataSignals.every((signal) => signal.aborted));
});

test('HarmonyOS launch resolves module metadata and reports missing launch data', async () => {
  const hdc = createHarmonyHdcRunnerStub([
    {
      stdout: JSON.stringify({
        hapModuleInfos: [{ mainElementName: 'EntryAbility', moduleName: 'entry' }],
      }),
    },
    { stdout: 'start ability successfully' },
  ]);

  await openHarmonyApp(hdc, DEVICE, 'com.example.application');
  assert.deepEqual(hdc.calls[1]?.args, [
    'aa',
    'start',
    '-a',
    'EntryAbility',
    '-b',
    'com.example.application',
    '-m',
    'entry',
  ]);

  hdc.answer({ stdout: 'not installed' });
  await assert.rejects(
    () => openHarmonyApp(hdc, DEVICE, 'com.example.missing'),
    /launchable ability/,
  );
});

test('openHarmonyApp classifies the locked-screen launch refusal as open-not-foreground', async () => {
  mockRunShell.mockResolvedValueOnce({
    exitCode: 0,
    stdout: [
      'error: failed to start ability.',
      'Error Code:10106102  Error Message:The device screen is locked during the application launch, unlock screen failed.',
    ].join('\n'),
    stderr: '',
  });

  await assert.rejects(
    () => openHarmonyApp(foregroundHdc, DEVICE, 'com.example.application', { activity: 'EntryAbility' }),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'open-not-foreground');
      assert.match(error.details?.hint ?? '', /Unlock the device screen/);
      return true;
    },
  );
});

function missionDump(packageName: string, state: string): string {
  return [
    'User ID #100',
    'Mission ID #28',
    `\tstate #${state}`,
    `\tmission name #[#${packageName}:entry:EntryAbility]`,
    '',
  ].join('\n');
}

test('pollHarmonyOpenForeground confirms the launched bundle on the first foreground read', async () => {
  mockRunShell.mockResolvedValueOnce({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application');

  assert.equal(read, undefined);
  assert.deepEqual(mockRunShell.mock.calls[0]?.[1], ['aa', 'dump', '-l']);
});

test('pollHarmonyOpenForeground keeps polling until the launched bundle holds the foreground', async () => {
  mockRunShell
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: missionDump('com.example.application', 'FOREGROUND'),
      stderr: '',
    });

  const read = await pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application', {
    pollIntervalMs: 1,
  });

  assert.equal(read, undefined);
  assert.equal(mockRunShell.mock.calls.length, 3);
});

test('pollHarmonyOpenForeground names the app that kept the foreground when the launch never surfaces', async () => {
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application', {
    pollBudgetMs: 60,
    pollIntervalMs: 10,
  });

  assert.deepEqual(read, { state: 'other-foreground', foregroundPackage: 'com.ohos.launcher' });
});

test('pollHarmonyOpenForeground classifies a mission list with no foreground mission as no-foreground', async () => {
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'BACKGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application', {
    pollBudgetMs: 40,
    pollIntervalMs: 10,
  });

  // The read answered — a mission list with no FOREGROUND mission is the
  // lock-screen shape, not a probe that failed to run.
  assert.deepEqual(read, { state: 'no-foreground' });
});

test('a mission-less keyguard dump reads as no-foreground, not as a dead probe', async () => {
  vi.useFakeTimers();
  mockRunShell.mockResolvedValue({ exitCode: 0, stdout: 'User ID #100\n', stderr: '' });
  const pending = pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application');
  await vi.advanceTimersByTimeAsync(HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS + 1_000);
  assert.deepEqual(await pending, { state: 'no-foreground' });
});

test('pollHarmonyOpenForeground reports probe-failed when every read fails', async () => {
  mockRunShell.mockRejectedValue(new Error('hdc died mid-read'));

  const read = await pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application', {
    pollBudgetMs: 40,
    pollIntervalMs: 10,
  });

  // A budget whose every read failed is a probe that never ran to an answer.
  assert.deepEqual(read, { state: 'probe-failed' });
});

test('pollHarmonyOpenForeground treats a failed read as unconfirmed and keeps polling', async () => {
  mockRunShell.mockRejectedValueOnce(new Error('hdc died mid-read')).mockResolvedValueOnce({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application', {
    pollIntervalMs: 1,
  });

  assert.equal(read, undefined);
});

test('pollHarmonyOpenForeground rejects when the request signal aborts mid-poll', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during the open foreground poll');
  mockRunShell.mockImplementation(async (_device, _args, options) => {
    return await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(abortReason), { once: true });
    });
  });

  const pending = pollHarmonyOpenForeground(foregroundHdc, DEVICE, 'com.example.application', {
    signal: controller.signal,
  });
  controller.abort(abortReason);

  await assert.rejects(pending, (error: unknown) => error === abortReason);
});

function openInput(overrides: Partial<OpenApplicationInput> = {}): OpenApplicationInput {
  return {
    positionals: ['com.example.application'],
    appBundleId: 'com.example.application',
    surface: 'app',
    hasExistingSession: false,
    relaunch: false,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/tmp/agent-device-open-foreground',
    runtimeHints: { values: {}, apply: async () => {} },
    execution: {},
    ...overrides,
  };
}

test('verifyHarmonyOpenForeground passes a confirmed foreground outcome through unchanged', async () => {
  mockRunShell.mockResolvedValueOnce({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });
  const outcome = { timing: {} };

  const verified = await verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput(),
    outcome,
    DEVICE,
    new AbortController().signal,
  );

  assert.equal(verified, outcome);
});

test('verifyHarmonyOpenForeground attaches the foreground read when the launch never surfaces', async () => {
  vi.useFakeTimers();
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput(),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS + 1_000);

  const verified = await pending;
  assert.deepEqual(verified.timing.foregroundVerification, {
    state: 'other-foreground',
    foregroundPackage: 'com.ohos.launcher',
  });
});

test('verifyHarmonyOpenForeground attaches no-foreground when a read answered with no foreground mission', async () => {
  vi.useFakeTimers();
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'BACKGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput(),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS + 1_000);

  const verified = await pending;
  assert.deepEqual(verified.timing.foregroundVerification, { state: 'no-foreground' });
});

test('verifyHarmonyOpenForeground fails --foreground with the unreadable reason when every read fails', async () => {
  vi.useFakeTimers();
  mockRunShell.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { foreground: true } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS + 1_000);

  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'open-foreground-probe-unreadable');
      assert.match(error.details?.hint ?? '', /check the device connection/i);
      return true;
    },
  );
});

test('verifyHarmonyOpenForeground reports probe-failed without reading when the request deadline has no room left', async () => {
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });

  // A deadline already in the past leaves the budget no room for one read:
  // the poll answers probe-failed at once instead of outliving the request.
  const verification = await verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { requestDeadlineAtMs: Date.now() - 1_000 } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  assert.deepEqual(verification.timing.foregroundVerification, { state: 'probe-failed' });
  assert.equal(mockRunShell.mock.calls.length, 0);
});

test('a far deadline keeps the 5s window and the connection hint when every read fails', async () => {
  vi.useFakeTimers();
  mockRunShell.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { foreground: true, requestDeadlineAtMs: Date.now() + 60_000 } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  // A deadline with 60s left never bounds the 5s poll: the failure names the
  // real window and sends the agent to the device, not to a bigger timeout.
  await vi.advanceTimersByTimeAsync(HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS + 1_000);
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.details?.reason, 'open-foreground-probe-unreadable');
      assert.match(String(error.message), /within 5s/);
      assert.doesNotMatch(error.details?.hint ?? '', /deadline/i);
      return true;
    },
  );
});

test('a partly clamped deadline keeps the computed window when every read fails', async () => {
  vi.useFakeTimers();
  mockRunShell.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { foreground: true, requestDeadlineAtMs: Date.now() + 2_000 } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  // A deadline with 2s left bounds the poll below the 5s default: the probe
  // failure names the 2s the poll actually had, so a literal "5s" revert
  // fails here. The clamp is not a squeeze to zero, so the hint stays the
  // connection one.
  await vi.advanceTimersByTimeAsync(3_000);
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.details?.reason, 'open-foreground-probe-unreadable');
      assert.match(String(error.message), /within 2s/);
      assert.doesNotMatch(String(error.message), /within 5s/);
      assert.match(error.details?.hint ?? '', /check the device connection/i);
      assert.doesNotMatch(error.details?.hint ?? '', /deadline/i);
      return true;
    },
  );
});

test('a partly clamped deadline names the deadline window on open-not-foreground', async () => {
  vi.useFakeTimers();
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'BACKGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { foreground: true, requestDeadlineAtMs: Date.now() + 2_000 } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(3_000);

  // The deadline cut the budget below 5s and reads answered with no
  // foreground: the failure names the deadline that bounded the poll.
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.details?.reason, 'open-not-foreground');
      assert.match(String(error.message), /before the request deadline/);
      assert.match(error.details?.hint ?? '', /unlock the device screen/i);
      return true;
    },
  );
});

test('verifyHarmonyOpenForeground names the deadline, not the connection, when the clamp spent the budget', async () => {
  mockRunShell.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { foreground: true, requestDeadlineAtMs: Date.now() - 1_000 } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'open-foreground-probe-unreadable');
      assert.match(error.details?.hint ?? '', /deadline is too tight/i);
      return true;
    },
  );
});

test('verifyHarmonyOpenForeground fails the open when --foreground demands the foreground and the launch never surfaces', async () => {
  vi.useFakeTimers();
  mockRunShell.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ execution: { foreground: true } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(HARMONY_OPEN_FOREGROUND_POLL_BUDGET_MS + 1_000);

  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'open-not-foreground');
      assert.equal(error.details?.foregroundPackage, 'com.ohos.launcher');
      assert.match(error.details?.hint ?? '', /unlock the device screen/i);
      return true;
    },
  );
});

test('verifyHarmonyOpenForeground skips verification without a bundle identity to verify', async () => {
  await verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ appBundleId: undefined }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await verifyHarmonyOpenForeground(
    foregroundHdc,
    openInput({ appBundleId: 'https://example.com' }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  assert.equal(mockRunShell.mock.calls.length, 0);
});
