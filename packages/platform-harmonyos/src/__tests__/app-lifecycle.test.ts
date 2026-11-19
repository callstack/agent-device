import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { afterEach, beforeEach, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

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
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import { runCmd } from '@agent-device/host-kit/command';

const mockRunCmd = vi.mocked(runCmd);

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
  mockRunCmd.mockReset();
  invalidateHarmonyGestureViewport.mockReset();
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

test('resolveHarmonyArchiveBundleName reads module metadata through unzip', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ app: { bundleName: 'com.example.application' } }),
    stderr: '',
  } as Awaited<ReturnType<typeof runCmd>>);

  await assert.doesNotReject(async () => {
    assert.equal(
      await resolveHarmonyArchiveBundleName('/tmp/example.hap'),
      'com.example.application',
    );
  });
  assert.deepEqual(mockRunCmd.mock.calls[0]?.slice(0, 2), [
    'unzip',
    ['-p', '/tmp/example.hap', 'module.json'],
  ]);
});

test('resolveHarmonyArchiveBundleName forwards the binding signal to in-flight unzip', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during Harmony archive resolution');
  mockRunCmd.mockImplementationOnce(async (_command, _args, options) => {
    assert.equal(options?.signal, controller.signal);
    return await rejectWhenAborted(options?.signal);
  });

  const pending = resolveHarmonyArchiveBundleName('/tmp/example.hap', controller.signal);
  controller.abort(abortReason);

  await assert.rejects(pending, (error: unknown) => error === abortReason);
});

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    if (!signal) {
      reject(new Error('archive resolver did not receive the binding signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('HarmonyOS lifecycle commands use HDC bundle and ability primitives', async () => {
  mockRunCmd
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'com.example.application\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'start ability successfully', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

  assert.deepEqual(await listHarmonyApps(DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  await openHarmonyApp(DEVICE, 'com.example.application', { activity: 'EntryAbility' });
  await closeHarmonyApp(DEVICE, 'com.example.application');

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([, args]) => args),
    [
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'],
      [
        '-t',
        'harmony-1',
        'shell',
        'aa',
        'start',
        '-a',
        'EntryAbility',
        '-b',
        'com.example.application',
      ],
      ['-t', 'harmony-1', 'shell', 'aa', 'force-stop', 'com.example.application'],
    ],
  );
  assert.deepEqual(invalidateHarmonyGestureViewport.mock.calls, [[DEVICE], [DEVICE]]);
});

test('openHarmonyApp refuses an ability name outside the module grammar before any hdc call', async () => {
  for (const activity of ['Entry$(id)', 'Entry;reboot', 'Entry Ability', '1Entry', 'Entry"x', '']) {
    await assert.rejects(
      () => openHarmonyApp(DEVICE, 'com.example.application', { activity }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.details?.reason === 'invalid-harmony-ability-name' &&
        error.details?.ability === activity,
    );
  }
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('HarmonyOS app listing filters user-installed bundles through Bundle Manager metadata', async () => {
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'com.example.application\ncom.ohos.settings\n',
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: { isSystemApp: false } }),
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: { isSystemApp: true } }),
      stderr: '',
    });

  assert.deepEqual(await listHarmonyApps(DEVICE, 'user-installed'), [
    { package: 'com.example.application', name: 'application' },
  ]);
  assert.deepEqual(
    mockRunCmd.mock.calls.map(([, args]) => args),
    [
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'],
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.example.application'],
      ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.ohos.settings'],
    ],
  );
});

test('HarmonyOS app listing preserves the complete inventory for the all filter', async () => {
  mockRunCmd.mockResolvedValueOnce({
    exitCode: 0,
    stdout: 'com.example.application\ncom.ohos.settings\n',
    stderr: '',
  });

  assert.deepEqual(await listHarmonyApps(DEVICE, 'all'), [
    { package: 'com.example.application', name: 'application' },
    { package: 'com.ohos.settings', name: 'settings' },
  ]);
  assert.deepEqual(
    mockRunCmd.mock.calls.map(([, args]) => args),
    [['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a']],
  );
});

test('HarmonyOS user-installed app listing rejects bundles without a system-app classification', async () => {
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'com.example.application\n',
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: {} }),
      stderr: '',
    });

  await assert.rejects(
    () => listHarmonyApps(DEVICE, 'user-installed'),
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
  let metadataCalls = 0;
  const abortedSignals: AbortSignal[] = [];
  mockRunCmd.mockImplementation(async (_command, args, options) => {
    if (args.at(-1) === '-a') {
      return { exitCode: 0, stdout: `${packages.join('\n')}\n`, stderr: '' } as Awaited<
        ReturnType<typeof runCmd>
      >;
    }
    metadataCalls++;
    if (args.at(-1) === 'com.example.app4') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ applicationInfo: {} }),
        stderr: '',
      } as Awaited<ReturnType<typeof runCmd>>;
    }
    const signal = options?.signal;
    assert(signal);
    abortedSignals.push(signal);
    return await new Promise<Awaited<ReturnType<typeof runCmd>>>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  });

  await assert.rejects(
    () => listHarmonyApps(DEVICE, 'user-installed'),
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
  assert.equal(abortedSignals.length, 3);
  assert(abortedSignals.every((signal) => signal.aborted));
});

test('HarmonyOS user-installed app listing aborts all metadata reads at its aggregate deadline', async () => {
  vi.useFakeTimers();
  const packages = Array.from({ length: 6 }, (_, index) => `com.example.app${index + 1}`);
  let metadataCalls = 0;
  const metadataSignals: AbortSignal[] = [];
  mockRunCmd.mockImplementation(async (_command, args, options) => {
    if (args.at(-1) === '-a') {
      return { exitCode: 0, stdout: `${packages.join('\n')}\n`, stderr: '' } as Awaited<
        ReturnType<typeof runCmd>
      >;
    }
    metadataCalls++;
    const signal = options?.signal;
    assert(signal);
    metadataSignals.push(signal);
    return await new Promise<Awaited<ReturnType<typeof runCmd>>>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('metadata request aborted')), {
        once: true,
      });
    });
  });

  const listing = listHarmonyApps(DEVICE, 'user-installed');
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
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        hapModuleInfos: [{ mainElementName: 'EntryAbility', moduleName: 'entry' }],
      }),
      stderr: '',
    })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'start ability successfully', stderr: '' });

  await openHarmonyApp(DEVICE, 'com.example.application');
  assert.deepEqual(mockRunCmd.mock.calls[1]?.[1], [
    '-t',
    'harmony-1',
    'shell',
    'aa',
    'start',
    '-a',
    'EntryAbility',
    '-b',
    'com.example.application',
    '-m',
    'entry',
  ]);

  mockRunCmd.mockResolvedValueOnce({ exitCode: 0, stdout: 'not installed', stderr: '' });
  await assert.rejects(() => openHarmonyApp(DEVICE, 'com.example.missing'), /launchable ability/);
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
  mockRunCmd.mockResolvedValueOnce({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(DEVICE, 'com.example.application');

  assert.equal(read, undefined);
  assert.deepEqual(mockRunCmd.mock.calls[0]?.[1], ['-t', 'harmony-1', 'shell', 'aa', 'dump', '-l']);
});

test('pollHarmonyOpenForeground keeps polling until the launched bundle holds the foreground', async () => {
  mockRunCmd
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

  const read = await pollHarmonyOpenForeground(DEVICE, 'com.example.application', {
    pollIntervalMs: 1,
  });

  assert.equal(read, undefined);
  assert.equal(mockRunCmd.mock.calls.length, 3);
});

test('pollHarmonyOpenForeground names the app that kept the foreground when the launch never surfaces', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(DEVICE, 'com.example.application', {
    pollBudgetMs: 60,
    pollIntervalMs: 10,
  });

  assert.deepEqual(read, { state: 'other-foreground', foregroundPackage: 'com.ohos.launcher' });
});

test('pollHarmonyOpenForeground classifies a mission list with no foreground mission as no-foreground', async () => {
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'BACKGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(DEVICE, 'com.example.application', {
    pollBudgetMs: 40,
    pollIntervalMs: 10,
  });

  // The read answered — a mission list with no FOREGROUND mission is the
  // lock-screen shape, not a probe that failed to run.
  assert.deepEqual(read, { state: 'no-foreground' });
});

test('pollHarmonyOpenForeground reports probe-failed when every read fails', async () => {
  mockRunCmd.mockRejectedValue(new Error('hdc died mid-read'));

  const read = await pollHarmonyOpenForeground(DEVICE, 'com.example.application', {
    pollBudgetMs: 40,
    pollIntervalMs: 10,
  });

  // A budget whose every read failed is a probe that never ran to an answer.
  assert.deepEqual(read, { state: 'probe-failed' });
});

test('pollHarmonyOpenForeground treats a failed read as unconfirmed and keeps polling', async () => {
  mockRunCmd.mockRejectedValueOnce(new Error('hdc died mid-read')).mockResolvedValueOnce({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });

  const read = await pollHarmonyOpenForeground(DEVICE, 'com.example.application', {
    pollIntervalMs: 1,
  });

  assert.equal(read, undefined);
});

test('pollHarmonyOpenForeground rejects when the request signal aborts mid-poll', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during the open foreground poll');
  mockRunCmd.mockImplementation(async (_command, _args, options) => {
    return await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(abortReason), { once: true });
    });
  });

  const pending = pollHarmonyOpenForeground(DEVICE, 'com.example.application', {
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
    runtimeHints: {},
    execution: {},
    ...overrides,
  };
}

test('verifyHarmonyOpenForeground passes a confirmed foreground outcome through unchanged', async () => {
  mockRunCmd.mockResolvedValueOnce({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });
  const outcome = { timing: {} };

  const verified = await verifyHarmonyOpenForeground(
    openInput(),
    outcome,
    DEVICE,
    new AbortController().signal,
  );

  assert.equal(verified, outcome);
});

test('verifyHarmonyOpenForeground attaches the foreground read when the launch never surfaces', async () => {
  vi.useFakeTimers();
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'BACKGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'FOREGROUND'),
    stderr: '',
  });

  // A deadline already in the past leaves the budget no room for one read:
  // the poll answers probe-failed at once instead of outliving the request.
  const verification = await verifyHarmonyOpenForeground(
    openInput({ execution: { requestDeadlineAtMs: Date.now() - 1_000 } }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  assert.deepEqual(verification.timing.foregroundVerification, { state: 'probe-failed' });
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('a far deadline keeps the 5s window and the connection hint when every read fails', async () => {
  vi.useFakeTimers();
  mockRunCmd.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.example.application', 'BACKGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockRejectedValue(new Error('hdc died mid-read'));
  const pending = verifyHarmonyOpenForeground(
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
  mockRunCmd.mockResolvedValue({
    exitCode: 0,
    stdout: missionDump('com.ohos.launcher', 'FOREGROUND'),
    stderr: '',
  });
  const pending = verifyHarmonyOpenForeground(
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
    openInput({ appBundleId: undefined }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );
  await verifyHarmonyOpenForeground(
    openInput({ appBundleId: 'https://example.com' }),
    { timing: {} },
    DEVICE,
    new AbortController().signal,
  );

  assert.equal(mockRunCmd.mock.calls.length, 0);
});
