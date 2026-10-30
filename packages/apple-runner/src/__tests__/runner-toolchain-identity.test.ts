import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  appleSelectionLink,
  STUBBED_APPLE_TOOLCHAIN,
  stubAppleSelectionLink,
  writeXcodeFixture,
} from './apple-toolchain-fixtures.ts';
import {
  readRunnerXcodeVersion,
  requireRunnerToolchainFingerprint,
  XCODE_SELECT_LINK_PATH,
  type AppleSdkName,
} from '../runner-toolchain-identity.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

stubAppleSelectionLink();

/** Every field differs from the stubbed toolchain, so a half read from the wrong Xcode shows. */
const XCODE_B_TOOLCHAIN = {
  xcodeVersion: '27.0',
  xcodeBuildVersion: '18A100',
  sdkVersion: '27.0',
  sdkBuildVersion: '24A100',
};
const FINGERPRINT_A = { ...STUBBED_APPLE_TOOLCHAIN, sdkName: 'iphonesimulator' };
const FINGERPRINT_B = { ...XCODE_B_TOOLCHAIN, sdkName: 'iphonesimulator' };

let xcodeA: string;
let xcodeB: string;

beforeEach(() => {
  xcodeA = writeXcodeFixture(mkdtempForTestSync('xcode-a-'));
  xcodeB = writeXcodeFixture(mkdtempForTestSync('xcode-b-'), XCODE_B_TOOLCHAIN);
});

function readFingerprint(sdkName: AppleSdkName = 'iphonesimulator') {
  return requireRunnerToolchainFingerprint(sdkName, undefined);
}

test('a client DEVELOPER_DIR names the Xcode the fingerprint is read from', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => xcodeB });
  assert.deepEqual(readFingerprint(), FINGERPRINT_B);
});

test('a DEVELOPER_DIR carrying a trailing newline names the dir alone', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => `${xcodeB}\n` });
  assert.deepEqual(readFingerprint(), FINGERPRINT_B);
});

test('a DEVELOPER_DIR naming the Xcode.app bundle reads its Contents/Developer', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => path.resolve(xcodeB, '../..') });
  assert.deepEqual(readFingerprint(), FINGERPRINT_B);
});

test('without DEVELOPER_DIR the host selection link names the Xcode, and a moved link moves it', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => undefined });
  appleSelectionLink.target = xcodeA;
  assert.deepEqual(readFingerprint(), FINGERPRINT_A);
  appleSelectionLink.target = xcodeB;
  assert.deepEqual(readFingerprint(), FINGERPRINT_B);
});

test('a selection link whose Xcode is gone fails instead of reading another Xcode', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => undefined });
  appleSelectionLink.target = path.join(mkdtempForTestSync('deleted-xcode-'), 'Xcode.app');
  assert.throws(
    readFingerprint,
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'apple_toolchain_unreadable' &&
      error.details?.file === XCODE_SELECT_LINK_PATH &&
      error.details?.detail === 'dangling selection link',
  );
});

test('a selection link this process cannot read fails instead of reading the default Xcode', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => undefined });
  vi.spyOn(fs, 'readlinkSync').mockImplementation(() => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });
  assert.throws(
    readFingerprint,
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'apple_toolchain_unreadable' &&
      error.details?.file === XCODE_SELECT_LINK_PATH &&
      error.details?.detail === 'EACCES',
  );
});

test('a bundle swapped behind a stable selection path is read from the bundle now standing there', () => {
  const stable = path.join(mkdtempForTestSync('xcode-stable-'), 'Xcode.app');
  fs.symlinkSync(path.resolve(xcodeA, '../..'), stable);
  appleRunnerTestHost.update({
    commandDeveloperDir: () => path.join(stable, 'Contents/Developer'),
  });
  assert.deepEqual(readFingerprint(), FINGERPRINT_A);

  fs.rmSync(stable);
  fs.symlinkSync(path.resolve(xcodeB, '../..'), stable);
  assert.deepEqual(readFingerprint(), FINGERPRINT_B);
});

test('a developer dir without an Xcode bundle fails with the file it could not read', () => {
  const commandLineTools = mkdtempForTestSync('command-line-tools-');
  appleRunnerTestHost.update({ commandDeveloperDir: () => commandLineTools });
  assert.throws(
    readFingerprint,
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'apple_toolchain_unreadable' &&
      error.details?.file === path.join(fs.realpathSync(commandLineTools), '..', 'version.plist'),
  );
  assert.equal(readRunnerXcodeVersion(), undefined);
});

test('a failure report reads the selected Xcode without waiting for a cache decision', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => xcodeB });
  assert.equal(readRunnerXcodeVersion(), '27.0');
});

test('the Xcode version is the bundle short version and product build, as xcodebuild prints', () => {
  fs.writeFileSync(
    path.join(xcodeB, '..', 'version.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>BuildVersion</key>
	<string>2</string>
	<key>CFBundleShortVersionString</key>
	<string>27.1</string>
	<key>CFBundleVersion</key>
	<string>24563</string>
	<key>ProductBuildVersion</key>
	<string>27A9275</string>
</dict>
</plist>
`,
  );
  appleRunnerTestHost.update({ commandDeveloperDir: () => xcodeB });
  assert.deepEqual(readFingerprint(), {
    ...FINGERPRINT_B,
    xcodeVersion: '27.1',
    xcodeBuildVersion: '27A9275',
  });
});

test('each runner SDK reads its version and build from its own platform directory', () => {
  const sdkDirectories: Record<AppleSdkName, string> = {
    iphonesimulator: 'iPhoneSimulator',
    iphoneos: 'iPhoneOS',
    appletvsimulator: 'AppleTVSimulator',
    appletvos: 'AppleTVOS',
    macosx: 'MacOSX',
    xrsimulator: 'XRSimulator',
    xros: 'XROS',
  };
  const expected = Object.entries(sdkDirectories).map(([sdkName, directory], index) => {
    const sdk = path.join(
      xcodeB,
      `Platforms/${directory}.platform/Developer/SDKs/${directory}.sdk`,
    );
    fs.writeFileSync(
      path.join(sdk, 'SDKSettings.json'),
      JSON.stringify({ Version: `30.${index}` }),
    );
    fs.writeFileSync(
      path.join(sdk, 'System/Library/CoreServices/SystemVersion.plist'),
      `<plist><dict><key>ProductBuildVersion</key><string>B${index}</string></dict></plist>`,
    );
    return {
      ...FINGERPRINT_B,
      sdkName: sdkName as AppleSdkName,
      sdkVersion: `30.${index}`,
      sdkBuildVersion: `B${index}`,
    };
  });
  appleRunnerTestHost.update({ commandDeveloperDir: () => xcodeB });
  for (const fingerprint of expected) {
    assert.deepEqual(readFingerprint(fingerprint.sdkName), fingerprint);
  }
});

test('a toolchain file without the key it must carry is a typed failure, not an empty value', () => {
  const settings = path.join(
    fs.realpathSync(xcodeB),
    'Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk/SDKSettings.json',
  );
  appleRunnerTestHost.update({ commandDeveloperDir: () => xcodeB });
  const unreadable = (detail: string) => (error: unknown) =>
    error instanceof AppError &&
    error.details?.reason === 'apple_toolchain_unreadable' &&
    error.details?.file === settings &&
    error.details?.detail === detail;
  fs.writeFileSync(settings, JSON.stringify({ Version: ' ' }));
  assert.throws(readFingerprint, unreadable('no Version'));
  fs.writeFileSync(settings, '{');
  assert.throws(readFingerprint, unreadable('not JSON'));
});
