import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageScript = path.join(repoRoot, 'scripts', 'package-apple-runner-source.mjs');
const runnerSnapshotSwiftPath = path.join(
  repoRoot,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Snapshot.swift',
);

test('package apple runner source strips unit-test blocks without mutating checkout source', async () => {
  const root = mkdtempForTestSync('agent-device-runner-package-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  writeStripFixtureTree(root);

  await runCmd(process.execPath, [packageScript, '--root', root, '--quiet']);

  const sourceSwiftPath = path.join(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
  );
  const packagedSwiftPath = path.join(
    root,
    'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
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
      path.join(root, 'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj'),
    ),
  );
  const packagedRunnerRoot = path.join(root, 'dist/apple/runner/AgentDeviceRunner');
  const packagedProject = fs.readFileSync(
    path.join(packagedRunnerRoot, 'AgentDeviceRunner.xcodeproj/project.pbxproj'),
    'utf8',
  );
  const sharedPackageRelativePath =
    packagedProject.match(/relativePath = ([^;]+);/)?.[1]?.trim() ?? '';
  assert.equal(sharedPackageRelativePath, '../../snapshot-presentation');
  assert.ok(
    fs.existsSync(path.resolve(packagedRunnerRoot, sharedPackageRelativePath, 'Package.swift')),
  );
  assert.ok(fs.existsSync(path.join(root, 'dist/apple/snapshot-presentation/Package.swift')));
  assert.equal(
    fs.readFileSync(path.join(root, 'dist/apple/snapshot-presentation/Package.swift'), 'utf8'),
    'runner package\n',
  );
  assert.ok(
    fs.existsSync(
      path.join(
        root,
        'dist/apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/Package.swift',
      ),
    ),
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'dist/apple/snapshot-presentation/Sources/SnapshotPresentationConformance'),
    ),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, 'dist/apple/snapshot-presentation/Tests')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist/apple/runner/README.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist/apple/runner/.build/cache.txt')), false);
  assert.equal(
    fs.existsSync(
      path.join(
        root,
        'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/xcuserdata/user.xcuserstate',
      ),
    ),
    false,
  );
});

test('package apple runner source skips the explicit unit-test directory', async () => {
  const root = mkdtempForTestSync('agent-device-runner-package-unit-tests-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(root, 'apple/snapshot-presentation/Package.runner.swift', 'runner package\n');
  const uitestsDir = 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests';
  writeFixtureFile(
    root,
    `${uitestsDir}/UnitTests/RunnerTests+SkeletonOnly.swift`,
    [
      'import XCTest',
      '',
      'extension RunnerTests {',
      '#if AGENT_DEVICE_RUNNER_UNIT_TESTS',
      '  func testSkeletonWholeBody() {}',
      '#endif',
      '}',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    root,
    `${uitestsDir}/RunnerTests+RuntimeSibling.swift`,
    ['extension RunnerTests {', '  func runtimeSiblingHelper() {}', '}', ''].join('\n'),
  );

  await runCmd(process.execPath, [packageScript, '--root', root, '--quiet']);

  assert.equal(
    fs.existsSync(path.join(root, `dist/${uitestsDir}/UnitTests/RunnerTests+SkeletonOnly.swift`)),
    false,
    'the package boundary must omit checkout-only unit-test sources',
  );
  assert.ok(
    fs.existsSync(path.join(root, `dist/${uitestsDir}/RunnerTests+RuntimeSibling.swift`)),
    'the skeleton skip must not drop files with shippable runtime content',
  );
});

test('package apple runner source check rejects unit tests without writing dist', async () => {
  const root = mkdtempForTestSync('agent-device-runner-package-testgate-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
    [
      'extension RunnerTests {',
      '#if AGENT_DEVICE_RUNNER_UNIT_TESTS',
      '  func testWrappedIsFine() {}',
      '#endif',
      '  func testLeaksIntoPackage() {}',
      '}',
      '',
    ].join('\n'),
  );

  const result = await runCmd(
    process.execPath,
    [packageScript, '--root', root, '--check', '--quiet'],
    { allowFailure: true },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /testLeaksIntoPackage/);
  assert.match(result.stderr, /AGENT_DEVICE_RUNNER_UNIT_TESTS/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});

test('package apple runner source allows only the runner entrypoint test method', async () => {
  const root = mkdtempForTestSync('agent-device-runner-package-entry-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(root, 'apple/snapshot-presentation/Package.runner.swift', 'runner package\n');

  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift',
    ['final class RunnerTests: XCTestCase {', '  func testCommand() throws {}', '}', ''].join('\n'),
  );

  const allowed = await runCmd(process.execPath, [packageScript, '--root', root, '--quiet']);
  assert.equal(allowed.exitCode, 0);

  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift',
    [
      'final class RunnerTests: XCTestCase {',
      '  func testCommand() throws {}',
      '  func testExtraEntrypoint() {}',
      '}',
      '',
    ].join('\n'),
  );

  const rejected = await runCmd(process.execPath, [packageScript, '--root', root, '--quiet'], {
    allowFailure: true,
  });
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /testExtraEntrypoint/);
});

test('package apple runner source removes legacy dist/apple-runner output before shipping', async () => {
  const root = mkdtempForTestSync('agent-device-runner-package-legacy-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));

  // Minimal current-layout source so packaging succeeds.
  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.pbxproj',
    '',
  );
  writeFixtureFile(root, 'apple/snapshot-presentation/Package.runner.swift', 'runner package\n');
  // Stale packaged trees left by builds/checkouts predating the apple-runner -> apple/runner
  // move. `dist` ships wholesale, so these must not survive packaging or they double-ship.
  writeFixtureFile(
    root,
    'dist/apple-runner/AgentDeviceRunner/RunnerTests+Legacy.swift',
    'legacy\n',
  );
  writeFixtureFile(
    root,
    'dist/apple/apple-runner/AgentDeviceRunner/RunnerTests+Mid.swift',
    'mid\n',
  );

  await runCmd(process.execPath, [packageScript, '--root', root, '--quiet']);

  assert.equal(fs.existsSync(path.join(root, 'dist/apple-runner')), false);
  assert.equal(fs.existsSync(path.join(root, 'dist/apple/apple-runner')), false);
  assert.ok(fs.existsSync(path.join(root, 'dist/apple/runner/AgentDeviceRunner')));
});

test('package apple runner source requires the shared snapshot presentation source', async () => {
  const root = mkdtempForTestSync('agent-device-runner-package-missing-presentation-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.pbxproj',
    '',
  );

  const result = await runCmd(process.execPath, [packageScript, '--root', root, '--quiet'], {
    allowFailure: true,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /snapshot presentation source not found/);
});

test('snapshot presentation manifests keep their supported platform declarations in parity', () => {
  const manifest = fs.readFileSync(
    path.join(repoRoot, 'apple/snapshot-presentation/Package.swift'),
    'utf8',
  );
  const runnerManifest = fs.readFileSync(
    path.join(repoRoot, 'apple/snapshot-presentation/Package.runner.swift'),
    'utf8',
  );

  for (const declaration of ['.iOS(.v15)', '.macOS(.v13)', '.tvOS(.v15)', '.visionOS(.v1)']) {
    const escaped = declaration.replaceAll(/[.()]/g, String.raw`\$&`);
    assert.match(manifest, new RegExp(escaped));
    assert.match(runnerManifest, new RegExp(escaped));
  }
});

test('apple runner tree snapshot capture stays on the main queue', () => {
  const source = fs.readFileSync(runnerSnapshotSwiftPath, 'utf8');
  const boundedCapture = extractSwiftFunction(source, 'captureSnapshotRootBounded');

  assert.doesNotMatch(boundedCapture, /DispatchQueue\.global/);
  assert.match(boundedCapture, /runMainThreadWork/);
  assert.match(boundedCapture, /captureSnapshotRoot\(element\)/);
});

test('runner uses the shared presenter without a local facade or model aliases', () => {
  const runnerRoot = path.join(repoRoot, 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests');
  assert.equal(
    fs.existsSync(path.join(runnerRoot, 'RunnerTests+SnapshotPresentation.swift')),
    false,
    'the runner must not recreate a local SnapshotPresentation facade',
  );
  assert.equal(
    fs.existsSync(path.join(runnerRoot, 'RunnerTests+SnapshotPresentationModels.swift')),
    false,
    'the runner must not recreate shared presenter type aliases',
  );

  const sourceFiles = fs
    .readdirSync(runnerRoot)
    .filter((entry) => entry.endsWith('.swift'))
    .map((entry) => fs.readFileSync(path.join(runnerRoot, entry), 'utf8'))
    .join('\n');
  assert.doesNotMatch(sourceFiles, /enum SnapshotPresentation\s*\{/);
  assert.doesNotMatch(
    sourceFiles,
    /typealias (?:RawAXNode|CaptureHint|SnapshotAcquisition|PresentedNode)\s*=/,
  );
  assert.match(sourceFiles, /import AgentDeviceSnapshotPresentation/);
});

function writeStripFixtureTree(root: string): void {
  writeFixtureFile(root, 'apple/runner/README.md', 'developer docs\n');
  writeFixtureFile(root, 'apple/runner/.build/cache.txt', 'cache\n');
  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.pbxproj',
    'relativePath = ../../snapshot-presentation;\n',
  );
  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/xcuserdata/user.xcuserstate',
    'state\n',
  );
  writeFixtureFile(root, 'apple/snapshot-presentation/Package.swift', 'package\n');
  writeFixtureFile(root, 'apple/snapshot-presentation/Package.runner.swift', 'runner package\n');
  writeFixtureFile(
    root,
    'apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/Package.swift',
    'package source\n',
  );
  writeFixtureFile(
    root,
    'apple/snapshot-presentation/Sources/SnapshotPresentationConformance/main.swift',
    'development harness\n',
  );
  writeFixtureFile(
    root,
    'apple/snapshot-presentation/Tests/AgentDeviceSnapshotPresentationTests/ConformanceTests.swift',
    'development tests\n',
  );
  writeFixtureFile(
    root,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Feature.swift',
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
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function extractSwiftFunction(source: string, name: string): string {
  const signatureIndex = source.indexOf(`func ${name}`);
  assert.notEqual(signatureIndex, -1, `missing Swift function ${name}`);
  const bodyStart = source.indexOf('{', signatureIndex);
  assert.notEqual(bodyStart, -1, `missing Swift function body ${name}`);
  // This lightweight guard assumes the target Swift function does not contain unmatched braces
  // inside string literals or comments; keep the source guard focused on small functions.
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(signatureIndex, index + 1);
  }
  assert.fail(`unterminated Swift function ${name}`);
}
