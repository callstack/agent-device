import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { build, type PlistValue } from 'plist';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
} from './apple-core-stub-helpers.ts';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>()),
  emitDiagnostic: vi.fn(),
}));
vi.mock('../simulator.ts', () => ({ ensureBootedSimulator: vi.fn() }));
// withFakeAppleTool installs a scoped provider, which never reads this host's preferences, so the
// host-read tests below call the prepare step outside it with runXcrun answered here.
vi.mock('../tool-provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-provider.ts')>();
  return { ...actual, runXcrun: vi.fn(actual.runXcrun) };
});
vi.mock('../ios-simulator-accessibility.ts', () => ({
  prepareIosSimulatorAccessibility: vi.fn(),
}));
const { emitDiagnostic } = await import('@agent-device/host-kit/diagnostics');
const { ensureBootedSimulator } = await import('../simulator.ts');
const { runXcrun, withAppleToolProvider } = await import('../tool-provider.ts');
const actualRunXcrun = (
  await vi.importActual<typeof import('../tool-provider.ts')>('../tool-provider.ts')
).runXcrun;
const { openIosApp } = await import('../app-launch.ts');
const { prepareIosSimulatorKeyboardIntros } = await import('../ios-simulator-keyboard.ts');

let setPath: string;
let device: DeviceInfo;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(runXcrun).mockImplementation(actualRunXcrun);
  setPath = await mkdtempForTest('agent-device-keyboard-set-');
  device = { ...IOS_TEST_SIMULATOR, simulatorSetPath: setPath };
});

function preferencesDir(): string {
  const dir = path.join(setPath, device.id, 'data/Library/Preferences');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePreferences(contents: Record<string, PlistValue>): void {
  fs.writeFileSync(
    path.join(preferencesDir(), 'com.apple.keyboard.preferences.plist'),
    build(contents),
  );
}

const keyWrite = (key: string) => [
  'simctl',
  '--set',
  setPath,
  'spawn',
  device.id,
  'defaults',
  'write',
  'com.apple.keyboard.preferences',
  key,
  '-bool',
  'YES',
];

const writtenKeys = (calls: string[][]) =>
  calls.filter((args) => args.includes('defaults')).map((args) => args.at(-3));

async function prepare(failKey?: string): Promise<string[][]> {
  vi.mocked(runXcrun).mockImplementation(async (args) => {
    if (failKey && args.includes(failKey)) throw new Error('denied');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await prepareIosSimulatorKeyboardIntros(device);
  return vi.mocked(runXcrun).mock.calls.map(([args]) => [...args]);
}

test('marks both intros as shown on a simulator whose preferences file is missing', async () => {
  assert.deepEqual(await prepare(), [
    keyWrite('DidShowContinuousPathIntroduction'),
    keyWrite('MultilingualKeyboardTip'),
  ]);
});

for (const [label, preferences, expected] of [
  [
    'both keys are on',
    { DidShowContinuousPathIntroduction: true, MultilingualKeyboardTip: true },
    [],
  ],
  ['one key is on', { DidShowContinuousPathIntroduction: true }, ['MultilingualKeyboardTip']],
  [
    'a key is off',
    { DidShowContinuousPathIntroduction: false, MultilingualKeyboardTip: true },
    ['DidShowContinuousPathIntroduction'],
  ],
] as const) {
  test(`writes only the missing keys when ${label} on this host`, async () => {
    writePreferences(preferences);
    assert.deepEqual(writtenKeys(await prepare()), expected);
  });
}

test('reads a binary preferences file as the simulator writes it', async () => {
  fs.copyFileSync(
    new URL('./fixtures/keyboard-intros-shown.plist', import.meta.url),
    path.join(preferencesDir(), 'com.apple.keyboard.preferences.plist'),
  );
  assert.deepEqual(await prepare(), []);
});

test('a scoped (remote) tool provider writes even when this host has both keys', async () => {
  writePreferences({ DidShowContinuousPathIntroduction: true, MultilingualKeyboardTip: true });
  const calls = await withAppleToolProvider({} as Parameters<typeof withAppleToolProvider>[0], () =>
    prepare(),
  );
  assert.deepEqual(writtenKeys(calls), [
    'DidShowContinuousPathIntroduction',
    'MultilingualKeyboardTip',
  ]);
});

test('a failed write warns and still writes the other key', async () => {
  const calls = await prepare('MultilingualKeyboardTip');
  assert.deepEqual(writtenKeys(calls), [
    'DidShowContinuousPathIntroduction',
    'MultilingualKeyboardTip',
  ]);
  assert.deepEqual(
    vi.mocked(emitDiagnostic).mock.calls.map(([event]) => event.phase),
    ['ios_simulator_keyboard_intro_prepare_failed'],
  );
});

for (const other of [
  IOS_TEST_DEVICE,
  MACOS_TEST_DEVICE,
  { ...IOS_TEST_SIMULATOR, appleOs: 'tvos' },
  { ...IOS_TEST_SIMULATOR, appleOs: 'visionos' },
] as DeviceInfo[]) {
  test(`does not write keyboard preferences for ${other.kind}/${other.appleOs}`, async () => {
    device = other;
    assert.deepEqual(await prepare(), []);
  });
}

for (const app of ['com.example.app', 'myapp://home']) {
  test(`open marks the intros after boot and before launching ${app}`, async () => {
    let booted = false;
    vi.mocked(ensureBootedSimulator).mockImplementation(async () => {
      booted = true;
    });
    const writeBootStates: boolean[] = [];
    await withFakeAppleTool(
      (args) => {
        if (args.includes('defaults')) writeBootStates.push(booted);
        return '';
      },
      async ({ calls }) => {
        await openIosApp(device, app, { appBundleId: 'com.example.app' });
        assert.deepEqual(writeBootStates, [true, true]);
        const launch = calls.findIndex((args) => args[3] === 'launch' || args[3] === 'openurl');
        assert.deepEqual(writtenKeys(calls.slice(0, launch)), [
          'DidShowContinuousPathIntroduction',
          'MultilingualKeyboardTip',
        ]);
      },
    );
  });
}

test('a failed write does not block the launch', async () => {
  await withFakeAppleTool(
    (args) => (args.includes('defaults') ? { exitCode: 1, stderr: 'denied' } : ''),
    async ({ calls }) => {
      await openIosApp(device, 'com.example.app', { appBundleId: 'com.example.app' });
      assert.equal(calls.at(-1)?.[3], 'launch');
    },
  );
});
