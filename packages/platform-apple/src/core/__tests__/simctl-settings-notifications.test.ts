import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { build, buildBinary, parse, parseBinary, type PlistValue } from 'plist';
import { renameHostPath } from '@agent-device/host-kit/host-file';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { applySimctlSetting, type AppleSimctlSettingRequest } from '../simctl-settings.ts';
import {
  SIMULATOR_NOTIFICATION_REASONS,
  SPRINGBOARD_RESTART_WARNING,
} from '../simulator-notification-permission.ts';

// Another app's record, which a write must carry over byte for byte.
const HOME_RECORD = new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 1, 2, 3]);

const SETTINGS: Record<string, PlistValue> = {
  sectionInfo: { 'com.apple.Home': HOME_RECORD },
  sectionInfoVersionNumber: 3,
};

vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/host-file')>();
  return { ...actual, renameHostPath: vi.fn(actual.renameHostPath) };
});

const LIST = ['spawn', 'SIM-1', 'launchctl', 'list'];

// Whether the app runs, the stop, a read until both services exit, the start, and a read until
// SpringBoard is back.
const RESTART = [
  LIST,
  ['spawn', 'SIM-1', 'launchctl', 'stop', 'com.apple.SpringBoard'],
  ['spawn', 'SIM-1', 'launchctl', 'stop', 'com.apple.usernotificationsd'],
  LIST,
  ['spawn', 'SIM-1', 'launchctl', 'start', 'com.apple.SpringBoard'],
  ['spawn', 'SIM-1', 'launchctl', 'start', 'com.apple.usernotificationsd'],
  LIST,
];

const APP_JOB = 'UIKitApplication:com.example.app[1a2b][rb-legacy]';

async function settingsFile(
  store: PlistValue = SETTINGS,
  format: 'xml' | 'binary' = 'xml',
): Promise<string> {
  const file = path.join(await mkdtempForTest('agent-device-bulletin-'), 'settings.plist');
  fs.writeFileSync(file, format === 'xml' ? build(store) : buildBinary(store));
  return file;
}

function readSettings(file: string): Record<string, PlistValue> {
  const bytes = fs.readFileSync(file);
  const binary = bytes.subarray(0, 8).toString() === 'bplist00';
  return (binary ? parseBinary(bytes) : parse(bytes.toString('utf8'))) as Record<
    string,
    PlistValue
  >;
}

function sections(file: string): Record<string, Uint8Array> {
  return readSettings(file).sectionInfo as Record<string, Uint8Array>;
}

/** The section id and authorization status an app's `BBSectionInfo` archive holds. */
function recordOf(record: Uint8Array | undefined): { sectionID: PlistValue; status: PlistValue } {
  if (!record) return expect.unreachable('expected a record for the app');
  const objects = (parseBinary(record) as { $objects: Array<Record<string, { UID: number }>> })
    .$objects;
  const info = objects[1]!;
  const settings = objects[info.sectionInfoSettings!.UID] as unknown as Record<string, PlistValue>;
  return {
    sectionID: objects[info.sectionID!.UID] as unknown as PlistValue,
    status: settings.authorizationStatus!,
  };
}

/**
 * A simulator's `launchctl`: `stop` ends a job and `start` gives it a process, unless a test holds
 * the job in its old state; a SpringBoard stop ends the app, and `simctl launch` brings it back.
 */
function recordingRunner(
  onRun: (args: string[]) => void = () => {},
  { appRunning = false, held = [] as string[] } = {},
) {
  const pids = new Map<string, number | undefined>([
    ['com.apple.SpringBoard', 100],
    ['com.apple.usernotificationsd', 101],
    [APP_JOB, appRunning ? 200 : undefined],
  ]);
  return vi.fn(async (args: string[]) => {
    onRun(args);
    const [, , tool, verb, label = ''] = args;
    if (tool === 'launchctl' && !held.includes(label)) {
      if (verb === 'stop') pids.set(label, undefined);
      if (verb === 'stop' && label === 'com.apple.SpringBoard') pids.set(APP_JOB, undefined);
      if (verb === 'start') pids.set(label, 300);
    }
    if (args[0] === 'launch') pids.set(APP_JOB, 400);
    const rows = [...pids].map(([job, pid]) => `${pid ?? '-'}\t0\t${job}`);
    return {
      stdout: verb === 'list' ? ['PID\tStatus\tLabel', ...rows].join('\n') : '',
      stderr: '',
    };
  });
}

function permission(
  runSimctl: AppleSimctlSettingRequest['runSimctl'],
  state: string,
  permissionTarget: string,
  notificationSettingsPath: string | undefined,
): AppleSimctlSettingRequest {
  return {
    runSimctl,
    udid: 'SIM-1',
    deviceId: 'SIM-1',
    setting: 'permission',
    state,
    appBundleId: 'com.example.app',
    resolveApp: async (app) => app,
    ...(notificationSettingsPath ? { notificationSettingsPath } : {}),
    options: { permissionTarget },
  };
}

test.for([
  { state: 'grant', status: 2 },
  { state: 'deny', status: 1 },
])(
  '$state notifications writes status $status between the SpringBoard stop and start',
  async ({ state, status }) => {
    const file = await settingsFile();
    const runSimctl = recordingRunner();

    const result = await applySimctlSetting(permission(runSimctl, state, 'notifications', file));

    expect(runSimctl.mock.calls.map(([args]) => args)).toEqual(RESTART);
    expect(result).toEqual({
      permission: 'notifications',
      warnings: [SPRINGBOARD_RESTART_WARNING],
    });
    expect(recordOf(sections(file)['com.example.app'])).toEqual({
      sectionID: 'com.example.app',
      status,
    });
    expect(sections(file)['com.apple.Home']).toEqual(HOME_RECORD);
    expect(readSettings(file).sectionInfoVersionNumber).toBe(3);
  },
);

test('reset notifications removes the app record and keeps the others', async () => {
  const file = await settingsFile();
  await applySimctlSetting(permission(recordingRunner(), 'grant', 'notifications', file));

  await applySimctlSetting(permission(recordingRunner(), 'reset', 'notifications', file));

  expect(Object.keys(sections(file))).toEqual(['com.apple.Home']);
});

test('a binary settings file is written back as binary', async () => {
  const file = await settingsFile(SETTINGS, 'binary');

  await applySimctlSetting(permission(recordingRunner(), 'grant', 'notifications', file));

  expect(fs.readFileSync(file).subarray(0, 8).toString()).toBe('bplist00');
  expect(recordOf(sections(file)['com.example.app']).status).toBe(2);
});

test('the edit applies to the file SpringBoard writes as it stops, not the one read before', async () => {
  const file = await settingsFile();
  const flushed = new Uint8Array([7, 7, 7]);
  const runSimctl = recordingRunner((args) => {
    if (args.join(' ') !== 'spawn SIM-1 launchctl stop com.apple.SpringBoard') return;
    const store = readSettings(file);
    (store.sectionInfo as Record<string, PlistValue>)['com.apple.Maps'] = flushed;
    fs.writeFileSync(file, build(store));
  });

  await applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file));

  expect(sections(file)['com.apple.Maps']).toEqual(flushed);
  expect(recordOf(sections(file)['com.example.app']).status).toBe(2);
});

test('a settings file that changes layout during the stop still restarts both services', async () => {
  const file = await settingsFile();
  const runSimctl = recordingRunner((args) => {
    if (args.join(' ') === 'spawn SIM-1 launchctl stop com.apple.SpringBoard') {
      fs.writeFileSync(file, build({ ...SETTINGS, sectionInfoVersionNumber: 4 }));
    }
  });

  await expect(
    applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file)),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: SIMULATOR_NOTIFICATION_REASONS.unrecognized.reason },
  });
  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual(RESTART.slice(0, -1));
});

test.for([
  { label: 'a newer layout version', store: { ...SETTINGS, sectionInfoVersionNumber: 4 } },
  { label: 'a key SpringBoard does not write', store: { ...SETTINGS, sectionOrder: [] } },
  { label: 'no sectionInfo', store: { sectionInfoVersionNumber: 3 } },
  { label: 'a sectionInfo array', store: { ...SETTINGS, sectionInfo: [] } },
  {
    label: 'a record that is not data',
    store: { ...SETTINGS, sectionInfo: { 'com.apple.Home': 'record' } },
  },
  { label: 'a top-level array', store: [SETTINGS] },
] as const)('a settings file with $label is refused before the restart', async ({ store }) => {
  const file = await settingsFile(store as PlistValue);
  const before = fs.readFileSync(file);
  const runSimctl = recordingRunner();

  await expect(
    applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file)),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: {
      reason: SIMULATOR_NOTIFICATION_REASONS.unrecognized.reason,
      deviceId: 'SIM-1',
      appBundleId: 'com.example.app',
    },
  });
  expect(runSimctl).not.toHaveBeenCalled();
  expect(fs.readFileSync(file)).toEqual(before);
});

test('a settings file that does not parse is refused before the restart', async () => {
  const file = await settingsFile();
  fs.writeFileSync(file, 'bplist00 truncated');
  const runSimctl = recordingRunner();

  await expect(
    applySimctlSetting(permission(runSimctl, 'deny', 'notifications', file)),
  ).rejects.toMatchObject({
    details: { reason: SIMULATOR_NOTIFICATION_REASONS.unrecognized.reason },
  });
  expect(runSimctl).not.toHaveBeenCalled();
});

test.for([
  {
    label: 'is missing',
    path: (file: string) => `${file}.absent`,
    reason: SIMULATOR_NOTIFICATION_REASONS.missing.reason,
  },
  {
    label: 'is out of reach of this host',
    path: () => undefined,
    reason: SIMULATOR_NOTIFICATION_REASONS.unreachable.reason,
  },
])('a settings file that $label is refused before the restart', async ({ path, reason }) => {
  const runSimctl = recordingRunner();

  await expect(
    applySimctlSetting(permission(runSimctl, 'reset', 'notifications', path(await settingsFile()))),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', details: { reason } });
  expect(runSimctl).not.toHaveBeenCalled();
});

test.for([
  { state: 'grant', action: 'grant', status: 2 },
  { state: 'deny', action: 'revoke', status: 1 },
])('$state all sets notifications last, with one restart', async ({ state, action, status }) => {
  const file = await settingsFile();
  const runSimctl = recordingRunner();

  const result = (await applySimctlSetting(permission(runSimctl, state, 'all', file))) as {
    permissions: string[];
    warnings: string[];
  };

  const argvs = runSimctl.mock.calls.map(([args]) => args);
  expect(argvs.slice(-RESTART.length)).toEqual(RESTART);
  expect(argvs.slice(0, -RESTART.length).every((args) => args[0] === 'privacy')).toBe(true);
  expect(argvs).toContainEqual(['privacy', 'SIM-1', action, 'camera', 'com.example.app']);
  expect(result.permissions.at(-1)).toBe('notifications');
  expect(result.warnings).toEqual([SPRINGBOARD_RESTART_WARNING]);
  expect(recordOf(sections(file)['com.example.app']).status).toBe(status);
});

test('grant all stops at a restart failure and names the services it changed', async () => {
  const file = await settingsFile();
  const failed = new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
    stderr: 'launchctl: no such process',
  });
  const runSimctl = vi.fn(async (args: string[]) => {
    if (args[0] === 'spawn') throw failed;
    return { stdout: '', stderr: '' };
  });

  await expect(applySimctlSetting(permission(runSimctl, 'grant', 'all', file))).rejects.toBe(
    failed,
  );
  expect(failed.details?.permissions).toContain('camera');
  expect(failed.details?.permissions).not.toContain('notifications');
});

test('reset all clears every privacy row, then removes the app notification record', async () => {
  const file = await settingsFile();
  await applySimctlSetting(permission(recordingRunner(), 'grant', 'notifications', file));
  const runSimctl = recordingRunner();

  const result = await applySimctlSetting(permission(runSimctl, 'reset', 'all', file));

  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual([
    ['privacy', 'SIM-1', 'reset', 'all', 'com.example.app'],
    ...RESTART,
  ]);
  expect(result).toEqual({
    permission: 'all',
    permissions: ['all', 'notifications'],
    warnings: [SPRINGBOARD_RESTART_WARNING],
  });
  expect(Object.keys(sections(file))).toEqual(['com.apple.Home']);
});

test('reset all that simctl refuses leaves the notification record alone', async () => {
  const file = await settingsFile();
  await applySimctlSetting(permission(recordingRunner(), 'grant', 'notifications', file));
  const refused = new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
    stderr: 'Failed to reset access\nOperation not permitted',
  });
  const runSimctl = vi.fn(async (_args: string[]) => {
    throw refused;
  });

  await expect(
    applySimctlSetting(permission(runSimctl, 'reset', 'all', file)),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', cause: refused });
  expect(runSimctl).toHaveBeenCalledTimes(1);
  expect(recordOf(sections(file)['com.example.app']).status).toBe(2);
});

test.for([
  { held: 'grant', state: 'grant' },
  { held: 'deny', state: 'deny' },
  { held: undefined, state: 'reset' },
])(
  '$state notifications on a file that already holds it changes nothing and restarts nothing',
  async ({ held, state }) => {
    const file = await settingsFile();
    if (held) await applySimctlSetting(permission(recordingRunner(), held, 'notifications', file));
    const before = fs.readFileSync(file);
    const runSimctl = recordingRunner();

    const result = await applySimctlSetting(permission(runSimctl, state, 'notifications', file));

    expect(result).toEqual({ permission: 'notifications' });
    expect(runSimctl).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  },
);

test.for([
  { label: 'another status', record: undefined },
  { label: 'an archive that does not parse', record: new Uint8Array([1, 2, 3]) },
])('a record with $label is rewritten with a restart', async ({ record }) => {
  const file = await settingsFile();
  if (record) {
    fs.writeFileSync(
      file,
      build({
        ...SETTINGS,
        sectionInfo: { 'com.apple.Home': HOME_RECORD, 'com.example.app': record },
      }),
    );
  } else {
    await applySimctlSetting(permission(recordingRunner(), 'deny', 'notifications', file));
  }
  const runSimctl = recordingRunner();

  await applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file));

  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual(RESTART);
  expect(recordOf(sections(file)['com.example.app']).status).toBe(2);
});

test('grant all on a file that already holds the grant counts notifications without a restart', async () => {
  const file = await settingsFile();
  await applySimctlSetting(permission(recordingRunner(), 'grant', 'notifications', file));
  const runSimctl = recordingRunner();

  const result = (await applySimctlSetting(permission(runSimctl, 'grant', 'all', file))) as {
    permissions: string[];
    warnings?: string[];
  };

  expect(runSimctl.mock.calls.every(([args]) => args[0] === 'privacy')).toBe(true);
  expect(result.permissions.at(-1)).toBe('notifications');
  expect(result.warnings).toBeUndefined();
});

test('an app that was running is opened again once SpringBoard is back', async () => {
  const file = await settingsFile();
  const runSimctl = recordingRunner(() => {}, { appRunning: true });

  const result = await applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file));

  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual([
    ...RESTART,
    ['launch', 'SIM-1', 'com.example.app'],
  ]);
  expect(result).toEqual({
    permission: 'notifications',
    warnings: [
      'Restarted SpringBoard to apply the notification permission, and opened com.example.app again because it was running.',
    ],
  });
});

test('a failed reopen keeps the applied change and says the app stayed closed', async () => {
  const file = await settingsFile();
  const fake = recordingRunner(() => {}, { appRunning: true });
  const runSimctl = vi.fn(async (args: string[]) => {
    if (args[0] === 'launch') throw new AppError('COMMAND_FAILED', 'simctl exited with code 4');
    return await fake(args);
  });

  const result = (await applySimctlSetting(
    permission(runSimctl, 'grant', 'notifications', file),
  )) as { warnings: string[] };

  expect(result.warnings).toEqual([
    `${SPRINGBOARD_RESTART_WARNING} Opening com.example.app again failed: simctl exited with code 4`,
  ]);
  expect(recordOf(sections(file)['com.example.app']).status).toBe(2);
});

test('the edit waits for SpringBoard to exit, so its last write cannot replace the edit', async () => {
  const file = await settingsFile();
  const flushed = new Uint8Array([7, 7, 7]);
  let exiting = 0;
  // SpringBoard ignores the stop and start verbs here; this test decides when it reports no process.
  const fake = recordingRunner(() => {}, { held: ['com.apple.SpringBoard'] });
  const runSimctl = vi.fn(async (args: string[]) => {
    const answer = await fake(args);
    const calls = fake.mock.calls.map(([call]) => call.join(' '));
    const stopped = calls.some((call) => call.endsWith('stop com.apple.SpringBoard'));
    const started = calls.some((call) => call.endsWith('start com.apple.SpringBoard'));
    if (args.join(' ') !== LIST.join(' ') || !stopped || started) return answer;
    exiting += 1;
    if (exiting < 3) return answer;
    // SpringBoard writes its copy as it exits, then reports no process.
    const store = readSettings(file);
    (store.sectionInfo as Record<string, PlistValue>)['com.apple.Maps'] = flushed;
    fs.writeFileSync(file, build(store));
    return {
      ...answer,
      stdout: answer.stdout.replace(/^\d+(\t0\tcom\.apple\.SpringBoard)$/m, '-$1'),
    };
  });

  await applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file));

  expect(exiting).toBe(3);
  expect(sections(file)['com.apple.Maps']).toEqual(flushed);
  expect(recordOf(sections(file)['com.example.app']).status).toBe(2);
});

/** Moves fake time on between the real file reads until the change settles. */
async function advanceUntilSettled(pending: Promise<unknown>): Promise<void> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let step = 0; step < 200 && !settled; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(200);
  }
}

test.for([
  { label: 'SpringBoard never exits', held: 'com.apple.SpringBoard', verb: 'stop', written: false },
  {
    label: 'usernotificationsd never exits',
    held: 'com.apple.usernotificationsd',
    verb: 'stop',
    written: false,
  },
  {
    label: 'SpringBoard never comes back',
    held: 'com.apple.SpringBoard',
    verb: 'start',
    written: true,
  },
])(
  'a restart where $label fails after 10 seconds and still starts both',
  async ({ held, verb, written }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const file = await settingsFile();
      const before = fs.readFileSync(file);
      const fake = recordingRunner();
      // The held job keeps the state it had before the verb.
      const runSimctl = vi.fn(async (args: string[]) => {
        if (args[3] === verb && args[4] === held) return { stdout: '', stderr: '' };
        return await fake(args);
      });

      const pending = applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file));
      const settled = expect(pending).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: SIMULATOR_NOTIFICATION_REASONS.restartTimeout.reason },
      });
      await advanceUntilSettled(pending);
      await settled;

      const argvs = runSimctl.mock.calls.map(([args]) => args.join(' '));
      expect(argvs).toContain('spawn SIM-1 launchctl start com.apple.SpringBoard');
      expect(argvs).toContain('spawn SIM-1 launchctl start com.apple.usernotificationsd');
      expect(fs.readFileSync(file).equals(before)).toBe(!written);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('a record that does not hold after the restart fails as not applied', async () => {
  const file = await settingsFile();
  const original = fs.readFileSync(file);
  const runSimctl = recordingRunner((args) => {
    // SpringBoard comes back with the settings it held before the edit.
    if (args.join(' ') === 'spawn SIM-1 launchctl start com.apple.SpringBoard') {
      fs.writeFileSync(file, original);
    }
  });

  await expect(
    applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file)),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: SIMULATOR_NOTIFICATION_REASONS.notApplied.reason },
  });
});

test('a failed rename removes its temporary file and leaves the settings whole', async () => {
  const file = await settingsFile();
  const before = fs.readFileSync(file);
  vi.mocked(renameHostPath).mockRejectedValueOnce(new Error('EXDEV: cross-device link'));
  const runSimctl = recordingRunner();

  await expect(
    applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file)),
  ).rejects.toThrow('EXDEV');

  expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(runSimctl.mock.calls.map(([args]) => args.join(' '))).toContain(
    'spawn SIM-1 launchctl start com.apple.SpringBoard',
  );
});

test('grant all fails on a restart that times out instead of skipping notifications', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const file = await settingsFile();
    const fake = recordingRunner();
    const runSimctl = vi.fn(async (args: string[]) =>
      args.join(' ') === 'spawn SIM-1 launchctl stop com.apple.SpringBoard'
        ? { stdout: '', stderr: '' }
        : await fake(args),
    );

    const pending = applySimctlSetting(permission(runSimctl, 'grant', 'all', file));
    const settled = expect(pending).rejects.toMatchObject({
      details: {
        reason: SIMULATOR_NOTIFICATION_REASONS.restartTimeout.reason,
        permissions: expect.arrayContaining(['camera']),
      },
    });
    await advanceUntilSettled(pending);
    await settled;
  } finally {
    vi.useRealTimers();
  }
});

test('another running app is not the one reopened', async () => {
  const file = await settingsFile();
  const fake = recordingRunner();
  const runSimctl = vi.fn(async (args: string[]) => {
    const answer = await fake(args);
    if (args.join(' ') !== LIST.join(' ')) return answer;
    return { ...answer, stdout: `${answer.stdout}\n300\t0\tUIKitApplication:com.apple.Maps[9f9f]` };
  });

  await applySimctlSetting(permission(runSimctl, 'grant', 'notifications', file));

  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual(RESTART);
});
