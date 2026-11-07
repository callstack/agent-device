import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { build } from 'plist';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

vi.mock('../tool-provider.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tool-provider.ts')>()),
  runXcrun: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

const { runXcrun } = await import('../tool-provider.ts');
const { prepareIosSimulatorAccessibility } = await import('../ios-simulator-accessibility.ts');

let setPath: string;
let device: DeviceInfo;

beforeEach(async () => {
  setPath = await mkdtempForTest('agent-device-ax-set-');
  device = { ...IOS_TEST_SIMULATOR, simulatorSetPath: setPath };
  vi.mocked(runXcrun).mockClear();
});

function writePreferences(contents: string | Record<string, unknown>): void {
  const dir = path.join(setPath, device.id, 'data/Library/Preferences');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'com.apple.Accessibility.plist'),
    typeof contents === 'string' ? contents : build(contents as Parameters<typeof build>[0]),
  );
}

const wrote = () => vi.mocked(runXcrun).mock.calls.some(([args]) => args.includes('defaults'));

for (const [label, preferences] of [
  ['the key is on', { ApplicationAccessibilityEnabled: true }],
  ['the key is 1', { ApplicationAccessibilityEnabled: 1 }],
  ['the key is absent', { ReduceMotionEnabled: false }],
] as const) {
  test(`skips the guest write when ${label} on this host`, async () => {
    writePreferences(preferences);
    await prepareIosSimulatorAccessibility(device);
    assert.equal(wrote(), false);
  });
}

for (const [label, write] of [
  ['the key is off', () => writePreferences({ ApplicationAccessibilityEnabled: false })],
  ['the key is 0', () => writePreferences({ ApplicationAccessibilityEnabled: 0 })],
  ['the file is malformed', () => writePreferences('bplist00 truncated')],
  ['the file is missing', () => {}],
] as const) {
  test(`writes when ${label}`, async () => {
    write();
    await prepareIosSimulatorAccessibility(device);
    assert.equal(wrote(), true);
  });
}

test('reads again on every launch, so a later teardown is seen', async () => {
  writePreferences({ ApplicationAccessibilityEnabled: true });
  await prepareIosSimulatorAccessibility(device);
  writePreferences({ ApplicationAccessibilityEnabled: false });
  await prepareIosSimulatorAccessibility(device);
  assert.equal(
    vi.mocked(runXcrun).mock.calls.filter(([args]) => args.includes('defaults')).length,
    1,
  );
});

for (const [value, expectWrite] of [
  ['true', false],
  ['false', true],
] as const) {
  test(`reads a binary preferences file as the simulator writes it (${value})`, async () => {
    const dir = path.join(setPath, device.id, 'data/Library/Preferences');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      new URL(`./fixtures/accessibility-${value}.plist`, import.meta.url),
      path.join(dir, 'com.apple.Accessibility.plist'),
    );
    await prepareIosSimulatorAccessibility(device);
    assert.equal(wrote(), expectWrite);
  });
}
