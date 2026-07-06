import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, test } from 'vitest';
import { runCmd } from '../utils/exec.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageScript = path.join(repoRoot, 'scripts', 'package-apple-runner-source.mjs');

test('package apple runner source strips unit-test blocks without mutating checkout source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runner-package-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFixtureFile(root, 'apple-runner/README.md', 'developer docs\n');
  writeFixtureFile(root, 'apple-runner/.build/cache.txt', 'cache\n');
  writeFixtureFile(
    root,
    'apple-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.pbxproj',
    '',
  );
  writeFixtureFile(
    root,
    'apple-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/xcuserdata/user.xcuserstate',
    'state\n',
  );
  writeFixtureFile(
    root,
    'apple-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
    [
      'extension RunnerTests {',
      '  func runtimeHelper() {}',
      '#if AGENT_DEVICE_RUNNER_UNIT_TESTS',
      '  func unitOnlyHelper() {',
      '    #if os(iOS)',
      '    print("nested platform guard should disappear with the unit-test block")',
      '    #endif',
      '  }',
      '#endif',
      '  #if os(macOS)',
      '  func macOnlyRuntimeHelper() {}',
      '  #endif',
      '}',
      '',
    ].join('\n'),
  );

  await runCmd(process.execPath, [packageScript, '--root', root, '--quiet']);

  const sourceSwiftPath = path.join(
    root,
    'apple-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
  );
  const packagedSwiftPath = path.join(
    root,
    'dist/apple-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
  );
  const sourceSwift = fs.readFileSync(sourceSwiftPath, 'utf8');
  const packagedSwift = fs.readFileSync(packagedSwiftPath, 'utf8');

  assert.match(sourceSwift, /AGENT_DEVICE_RUNNER_UNIT_TESTS/);
  assert.doesNotMatch(packagedSwift, /AGENT_DEVICE_RUNNER_UNIT_TESTS/);
  assert.doesNotMatch(packagedSwift, /unitOnlyHelper/);
  assert.match(packagedSwift, /runtimeHelper/);
  assert.match(packagedSwift, /#if os\(macOS\)/);
  assert.ok(
    fs.existsSync(
      path.join(root, 'dist/apple-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj'),
    ),
  );
  assert.equal(fs.existsSync(path.join(root, 'dist/apple-runner/README.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist/apple-runner/.build/cache.txt')), false);
  assert.equal(
    fs.existsSync(
      path.join(
        root,
        'dist/apple-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/xcuserdata/user.xcuserstate',
      ),
    ),
    false,
  );
});

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}
