/**
 * The failure direction of the package's no-test-code guard. `pnpm check:package` can only ever
 * watch a healthy package pass, so the predicates that decide the verdict get exercised here,
 * against fixture paths and fixture bytes: a test file that entered the packed tree has to fail,
 * and the product code that merely names a test token must not.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DOCUMENTED_PACK_STUBS,
  testOnlyContentFailures,
  testOnlyPathFailures,
} from '../lib/shipped-test-code.ts';

const RUNNER_HOST_APP =
  'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerApp.m';

test('testOnlyPathFailures rejects each test-only directory the packager must not copy', () => {
  const failures = testOnlyPathFailures([
    'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/UnitTests/RunnerTests+AlertTests.swift',
    'apple/macos-helper/Tests/AgentDeviceMacOSHelperTests/HelperTests.swift',
    'dist/src/__tests__/daemon.test.js',
    'dist/fixtures/sample.json',
    'dist/mocks/device-factory.js',
  ]);
  assert.equal(failures.length, 5);
  assert.match(failures[0], /UnitTests/);
});

test('testOnlyPathFailures rejects test-only file names in any shipped language', () => {
  const failures = testOnlyPathFailures([
    'dist/src/session.test.js',
    'dist/src/router.spec.mjs',
    'apple/snapshot-bridge/SnapshotBridgeForTesting.m',
    'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerAppFixtures.m',
  ]);
  // The fixture host is dropped by the packager's file list, not by its name; the guard's content
  // pass owns it, so only the three test-named paths may report here.
  assert.equal(failures.length, 3);
});

test('testOnlyPathFailures exempts only the two documented PackStubs under Tests/', () => {
  assert.deepEqual(testOnlyPathFailures([...DOCUMENTED_PACK_STUBS]), []);
  assert.equal(
    testOnlyPathFailures(['apple/macos-helper/Tests/AgentDeviceMacOSInputTests/ExtraTests.swift'])
      .length,
    1,
  );
});

test('testOnlyPathFailures accepts the product paths that name tests without being tests', () => {
  assert.deepEqual(
    testOnlyPathFailures([
      'dist/src/session-test-source-discovery.js',
      'dist/src/legacy-xctest-device-set.js',
      'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift',
      'README.md',
    ]),
    [],
  );
});

test('testOnlyContentFailures rejects unit-test source that survived the packager strip', () => {
  const failures = testOnlyContentFailures([
    {
      path: 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Alert.swift',
      contents: '#if AGENT_DEVICE_RUNNER_UNIT_TESTS\nfunc testAlerts() {}\n#endif\n',
    },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /AGENT_DEVICE_RUNNER_UNIT_TESTS/);
});

test('testOnlyContentFailures rejects a --agent-device-* fixture argument in the packaged host app', () => {
  const failures = testOnlyContentFailures([
    {
      path: RUNNER_HOST_APP,
      contents:
        '  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-back-regression"]) {\n',
    },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /--agent-device-\* fixture/);
});

test('testOnlyContentFailures accepts the packaged host app and product daemon code that name test tokens', () => {
  assert.deepEqual(
    testOnlyContentFailures([
      {
        path: RUNNER_HOST_APP,
        contents: '@implementation AgentDeviceRunnerViewController\n@end\n',
      },
      {
        path: 'dist/src/runner.js',
        contents: 'const flag = "-D AGENT_DEVICE_RUNNER_UNIT_TESTS";\n',
      },
      {
        path: 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/Info.plist',
        contents: '<string>AGENT_DEVICE_RUNNER_UNIT_TESTS</string>',
      },
    ]),
    [],
  );
});
