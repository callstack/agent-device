import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { appleRunnerTestHost } from '../test-host.ts';
import type { ExecResult } from '@agent-device/host-kit/command';
import { ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { seedRunnerProductBundle } from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

const XCTESTRUN_NAME =
  'AgentDeviceRunner_AgentDeviceRunnerUITests_iphonesimulator27.0-arm64.xctestrun';

const runCmdStreaming = vi.fn();
let projectRoot: string;
let derived: string;
let customBuildLocation: string;

beforeEach(() => {
  resetAllProcessMemosForTests();
  projectRoot = mkdtempForTestSync('agent-device-runner-location-root-');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  derived = mkdtempForTestSync('agent-device-runner-location-derived-');
  customBuildLocation = mkdtempForTestSync('agent-device-runner-location-custom-');
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derived;
  runCmdStreaming.mockReset().mockImplementation(xcodebuildHonoringCustomBuildLocation);
  appleRunnerTestHost.update({
    runCmdSync: vi.fn().mockImplementation(appleToolchainProbeResult),
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
});

test('a custom Xcode build location cannot move the built xctestrun out of the runner cache', async () => {
  const built = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  assert.equal(built.artifact, 'rebuilt');
  assert.equal(built.xctestrunPath, path.join(derived, 'Build', 'Products', XCTESTRUN_NAME));
  assert.deepEqual(fs.readdirSync(customBuildLocation), []);

  const reused = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  assert.equal(reused.artifact, 'valid');
  assert.equal(reused.xctestrunPath, built.xctestrunPath);
  assert.equal(runCmdStreaming.mock.calls.length, 1);
});

/**
 * Stands in for `xcodebuild build-for-testing` on a host whose Xcode settings set a custom build
 * location: products land there unless the command line pins `SYMROOT`.
 */
async function xcodebuildHonoringCustomBuildLocation(
  _command: string,
  args: string[],
): Promise<ExecResult> {
  const symroot = args.find((arg) => arg.startsWith('SYMROOT='))?.slice('SYMROOT='.length);
  const productsRoot = symroot ?? customBuildLocation;
  await seedRunnerProductBundle(
    path.join(productsRoot, 'Debug-iphonesimulator', 'AgentDeviceRunner.app'),
  );
  fs.writeFileSync(
    path.join(productsRoot, XCTESTRUN_NAME),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${projectRoot}</string>
  <key>ProductPaths</key>
  <array>
    <string>__TESTROOT__/Debug-iphonesimulator/AgentDeviceRunner.app</string>
  </array>
</dict>
</plist>`,
  );
  return { exitCode: 0, stdout: '', stderr: '' };
}
