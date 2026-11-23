import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { build, buildBinary, parse, parseBinary, type PlistValue } from 'plist';
import type { SimctlSettingRequest } from '@agent-device/contracts/settings';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { applySimctlSetting } from '../simctl-settings.ts';
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

const RESTART = [
  ['spawn', 'SIM-1', 'launchctl', 'stop', 'com.apple.SpringBoard'],
  ['spawn', 'SIM-1', 'launchctl', 'stop', 'com.apple.usernotificationsd'],
  ['spawn', 'SIM-1', 'launchctl', 'start', 'com.apple.SpringBoard'],
  ['spawn', 'SIM-1', 'launchctl', 'start', 'com.apple.usernotificationsd'],
];

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

function recordingRunner(onRun: (args: string[]) => void = () => {}) {
  return vi.fn(async (args: string[]) => {
    onRun(args);
    return { stdout: '', stderr: '' };
  });
}

function permission(
  runSimctl: SimctlSettingRequest['runSimctl'],
  state: string,
  permissionTarget: string,
  notificationSettingsPath: string | undefined,
): SimctlSettingRequest {
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
  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual(RESTART);
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

test('reset all with a settings file stays one simctl privacy call', async () => {
  const file = await settingsFile();
  const runSimctl = recordingRunner();

  await applySimctlSetting(permission(runSimctl, 'reset', 'all', file));

  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual([
    ['privacy', 'SIM-1', 'reset', 'all', 'com.example.app'],
  ]);
});
