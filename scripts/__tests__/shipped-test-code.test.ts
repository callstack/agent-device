/**
 * The failure direction of the package's no-test-code guard. `pnpm check:package` can only ever
 * watch a healthy package pass, so the predicates that decide the verdict get exercised here,
 * against fixture paths and fixture bytes: a test file that entered the packed tree has to fail,
 * and the product code that merely names a test token must not.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  DOCUMENTED_PACK_STUBS,
  testOnlyContentFailures,
  testOnlyPathFailures,
} from '../lib/shipped-test-code.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

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
    'dist/src/runner.test.d.ts',
    'apple/snapshot-bridge/SnapshotBridgeForTesting.m',
  ]);
  // The fixture host is dropped by the packager's file list, not by its name; the content pass
  // owns it, so only the test-named paths may report here.
  assert.equal(failures.length, 4);
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
    {
      // The Objective-C spelling the fixtures file uses, where the flag sits inside defined().
      path: 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/Sources/RunnerTests.m',
      contents: '#if TARGET_OS_IOS && defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)\n@end\n',
    },
    {
      // A backslash-continued condition: the token is still a token, so the leak is caught.
      path: 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/Sources/ContinuedTests.m',
      contents: '#if TARGET_OS_IOS && \\\n    defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)\n@end\n',
    },
  ]);
  assert.equal(failures.length, 3);
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

test('testOnlyContentFailures scans the packaged host app target at any depth', () => {
  // The packager-side guard scans the host app target recursively; this must not be shallower, or
  // a fixture screen under a subdirectory of the target ships while the re-check says nothing.
  const failures = testOnlyContentFailures([
    {
      path: 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/Screens/AgentDeviceFixtures.m',
      contents: '[arguments containsObject:@"--agent-device-crowded-screen"]',
    },
  ]);
  assert.equal(failures.length, 1);
});

test("testOnlyContentFailures rejects the repo's real fixtures file, the leak the guard must catch", () => {
  // The leak this PR fixes: the fixture screens lived in the shipped host app. If the packager's
  // drop entry for AgentDeviceRunnerAppFixtures.m were ever removed, these exact bytes would ride
  // into the tarball under the host app target; the content pass must reject them.
  const fixturesPath = path.join(
    repoRoot,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerAppFixtures.m',
  );
  const failures = testOnlyContentFailures([
    {
      path: 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerAppFixtures.m',
      contents: fs.readFileSync(fixturesPath, 'utf8'),
    },
  ]);
  // Both predicates fire on it: the unit-test compile guard and the fixture launch arguments.
  assert.equal(failures.length, 2);
});

test('testOnlyContentFailures accepts the real shipped host app and product code that names test tokens', () => {
  // The healthy side over real bytes: what the package ships today must report nothing, even
  // though the host app discusses the fixtures file and the daemon constructs the unit-test flag.
  const hostApp = fs.readFileSync(
    path.join(repoRoot, 'apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerApp.m'),
    'utf8',
  );
  assert.deepEqual(
    testOnlyContentFailures([
      { path: RUNNER_HOST_APP, contents: hostApp },
      {
        path: 'dist/src/runner.js',
        contents: 'const flag = "-D AGENT_DEVICE_RUNNER_UNIT_TESTS";\n',
      },
    ]),
    [],
  );
});
