// Device-lane ownership (#1781 A9-2): planted paths per family, and the two properties the
// ios.yml routing leans on — an Apple-owned change carries its iOS checks in a narrow plan, and
// a tooling change beside it still fails open to the full set.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceLaneLeaf, deviceLanesFor, isDeviceLaneSurface, isUnitTest } from './device-lanes.ts';
import { selectChecks, type CheckId } from './model.ts';

const IOS: readonly CheckId[] = ['replay-ios', 'replay-ios-device'];

function lanes(file: string): CheckId[] {
  const plan = selectChecks({ changedFiles: [file] });
  assert.equal(plan.failOpen, false, `${file} must not fail open`);
  return plan.checks.filter((id) =>
    /^macos-coverage$|^replay-|^linux-command-evidence$|^web-smoke$|^swift-runner-|^macos-helper$|^android-helpers$/.test(
      id,
    ),
  );
}

test('a TypeScript-only Apple change selects the iOS and macOS lanes without a Swift build', () => {
  for (const file of [
    'packages/platform-apple/src/core/app-resolution.ts',
    'packages/platform-apple/src/runtime.ts',
    'packages/platform-apple/src/os/macos/desktop-scroll.ts',
  ]) {
    assert.deepEqual(lanes(file), ['replay-ios', 'replay-ios-device', 'replay-macos'], file);
    assert.ok(
      selectChecks({ changedFiles: [file] }).reasons.some(
        (reason) => reason.rule === 'own:device-lane:apple',
      ),
    );
  }
  assert.deepEqual(lanes('src/snapshot/snapshot-presentation/ios/action-shelf.ts'), [...IOS]);
  assert.deepEqual(lanes('test/integration/replays/macos/01-desktop.ad'), ['replay-macos']);
});

test('a Swift runner change selects both builds and every Apple lane', () => {
  assert.deepEqual(lanes('apple/runner/AgentDeviceRunner/Sources/Foo.swift'), [
    'swift-runner-ios',
    'swift-runner-macos',
    'replay-ios',
    'replay-ios-device',
    'replay-macos',
  ]);
});

test('an iOS replay script and the iOS smoke files own the iOS lanes', () => {
  for (const file of [
    'test/integration/replays/ios/simulator/01-settings.ad',
    'test/integration/replays/ios/fixture/02-checkout-release.ad',
    'test/integration/smoke-ios-simulator.test.ts',
    'test/integration/ios-simulator-e2e/live-runner.ts',
    'test/integration/ios-simulator-e2e-cleanup.test.ts',
  ]) {
    assert.deepEqual(lanes(file), [...IOS], file);
  }
});

test('the macOS coverage manifest selects its executable gate and macOS replay lane', () => {
  assert.deepEqual(lanes('test/integration/smoke-macos-coverage.test.ts'), [
    'macos-coverage',
    'replay-macos',
  ]);
  assert.deepEqual(lanes('test/integration/macos-e2e/coverage-manifest.ts'), [
    'macos-coverage',
    'replay-macos',
  ]);
});

test('shared runtime surface owns every device lane', () => {
  for (const file of [
    'src/daemon/handlers/session.ts',
    'packages/kernel/src/errors.ts',
    'src/daemon/android-system-dialog.ts', // naming convention in a shared dir, not a boundary
    'test/integration/smoke-daemon-clean.test.ts',
    'src/platforms/install-source.ts',
  ]) {
    assert.equal(deviceLaneLeaf(file), 'shared', file);
    assert.deepEqual(lanes(file), [
      'web-smoke',
      'replay-ios',
      'replay-ios-device',
      'replay-macos',
      'replay-linux',
      'linux-command-evidence',
      'replay-android',
    ]);
  }
});

test('another family owns only its own lanes, so an Android-only change carries no iOS check', () => {
  assert.deepEqual(lanes('packages/platform-android/src/perf.ts'), ['replay-android']);
  assert.deepEqual(lanes('packages/platform-android/src/inventory.ts'), ['replay-android']);
  assert.deepEqual(lanes('android/snapshot-helper/src/main/java/X.java'), [
    'android-helpers',
    'replay-android',
  ]);
  assert.deepEqual(lanes('test/integration/replays/android/emulator/01-settings.ad'), [
    'replay-android',
  ]);
  assert.deepEqual(lanes('test/integration/smoke-android-emulator.test.ts'), ['replay-android']);
  assert.deepEqual(lanes('test/integration/android-emulator-e2e/live-runner.ts'), [
    'replay-android',
  ]);
  assert.deepEqual(lanes('packages/platform-linux/src/snapshot.ts'), [
    'replay-linux',
    'linux-command-evidence',
  ]);
  assert.deepEqual(lanes('linux/atspi-dump.py'), ['replay-linux', 'linux-command-evidence']);
  assert.deepEqual(lanes('packages/platform-web/src/provider.ts'), ['web-smoke']);
  assert.deepEqual(lanes('test/integration/smoke-web-platform.test.ts'), ['web-smoke']);
  // Families with no CI lane fall through to the static gates only.
  assert.deepEqual(lanes('packages/platform-harmonyos/src/hdc.ts'), []);
  assert.deepEqual(lanes('packages/platform-vega/src/index.ts'), []);
});

test('the fixture app owns the mobile lanes whichever subtree changes', () => {
  assert.deepEqual(lanes('examples/test-app/app/index.tsx'), [
    'replay-ios',
    'replay-ios-device',
    'replay-android',
  ]);
  assert.equal(deviceLaneLeaf('examples/test-app/modules/lab/android/build.gradle'), 'fixture-app');
});

test('unit tests under src/ and packages/*/src own no lane', () => {
  for (const file of [
    'src/daemon/selectors.test.ts',
    'src/__tests__/contracts/interaction-guarantees.test.ts',
    'packages/platform-apple/src/core/__tests__/apps.test.ts',
    'packages/platform-apple/src/runtime.test.ts',
  ]) {
    assert.ok(isUnitTest(file), file);
    assert.ok(!isDeviceLaneSurface(file), file);
    assert.deepEqual(lanes(file), [], file);
  }
  // Non-TypeScript under __tests__ is a fixture the selector cannot place, not a unit test.
  assert.ok(!isUnitTest('src/__tests__/test-utils/android-ime-capture.raw.json'));
  // Package tests outside src/ have no owner and keep failing open.
  assert.ok(!isUnitTest('packages/maestro/test/conformance/verify.test.ts'));
  assert.equal(
    selectChecks({ changedFiles: ['packages/maestro/test/conformance/verify.test.ts'] }).failOpen,
    true,
  );
});

test('a mixed tree is shared, and two Apple leaves are still Apple', () => {
  assert.equal(deviceLaneLeaf('packages/platform-apple/src/os/macos/x.ts'), 'apple');
  assert.equal(deviceLaneLeaf('test/integration/android-emulator-e2e/ios/x.ts'), 'shared');
  assert.deepEqual(deviceLanesFor('packages/platform-apple/src/os/macos/x.ts').lanes, [
    'replay-ios',
    'replay-ios-device',
    'replay-macos',
  ]);
});

test('the surface never narrows a file the selector could not otherwise place', () => {
  for (const file of [
    'src/global.d.ts',
    'src/foo.json',
    'test/integration/ios-simulator-e2e/a.png',
  ]) {
    assert.ok(!isDeviceLaneSurface(file), file);
    assert.equal(selectChecks({ changedFiles: [file] }).failOpen, true, file);
  }
});

test('a golden table owns the parity unit test and both runner builds', () => {
  const plan = selectChecks({ changedFiles: ['contracts/fixtures/tap-point-policy.json'] });
  assert.equal(plan.failOpen, false);
  for (const id of ['unit', 'swift-runner-ios', 'swift-runner-macos'] as const) {
    assert.ok(plan.checks.includes(id), id);
  }
  assert.ok(plan.reasons.some((reason) => reason.rule === 'own:golden-table'));
});

test('a tooling change beside an Android-only change still fails open to the full set', () => {
  for (const tooling of [
    '.github/workflows/ios.yml',
    '.github/actions/setup-apple-runner-build/action.yml',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'vitest.config.ts',
    'scripts/check-affected/device-lanes.ts',
    'packages/platform-android/package.json',
  ]) {
    const plan = selectChecks({ changedFiles: ['packages/platform-android/src/perf.ts', tooling] });
    assert.equal(plan.failOpen, true, tooling);
    assert.ok(plan.checks.includes('swift-runner-ios'), tooling);
    assert.ok(plan.checks.includes('replay-ios'), tooling);
  }
});
