import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  computeRunnerSourceFingerprint,
  resolveAppleRunnerProjectPath,
  resolveAppleRunnerSourceRoot,
  resolveAppleSnapshotPresentationSourceRoot,
} from '../runner-source.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

test('resolveAppleRunnerSourceRoot prefers checkout source over packaged source', () => {
  const root = makeTempRoot();
  const checkoutSource = path.join(root, 'apple', 'runner', 'AgentDeviceRunner');
  const packagedSource = path.join(root, 'dist', 'apple', 'runner', 'AgentDeviceRunner');
  fs.mkdirSync(path.join(checkoutSource, 'AgentDeviceRunner.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(packagedSource, 'AgentDeviceRunner.xcodeproj'), { recursive: true });

  assert.equal(resolveAppleRunnerSourceRoot(root), checkoutSource);
  assert.equal(
    resolveAppleRunnerProjectPath(root),
    path.join(checkoutSource, 'AgentDeviceRunner.xcodeproj'),
  );
});

test('resolveAppleRunnerSourceRoot falls back to packaged source', () => {
  const root = makeTempRoot();
  const packagedSource = path.join(root, 'dist', 'apple', 'runner', 'AgentDeviceRunner');
  fs.mkdirSync(path.join(packagedSource, 'AgentDeviceRunner.xcodeproj'), { recursive: true });

  assert.equal(resolveAppleRunnerSourceRoot(root), packagedSource);
  assert.equal(
    resolveAppleRunnerProjectPath(root),
    path.join(packagedSource, 'AgentDeviceRunner.xcodeproj'),
  );
});

test('resolveAppleSnapshotPresentationSourceRoot prefers checkout source over packaged source', () => {
  const root = makeTempRoot();
  const checkoutSource = path.join(root, 'apple', 'snapshot-presentation');
  const packagedSource = path.join(root, 'dist', 'apple', 'snapshot-presentation');
  fs.mkdirSync(checkoutSource, { recursive: true });
  fs.mkdirSync(packagedSource, { recursive: true });

  assert.equal(resolveAppleSnapshotPresentationSourceRoot(root), checkoutSource);
});

test('resolveAppleSnapshotPresentationSourceRoot falls back to packaged source', () => {
  const root = makeTempRoot();
  const packagedSource = path.join(root, 'dist', 'apple', 'snapshot-presentation');
  fs.mkdirSync(packagedSource, { recursive: true });

  assert.equal(resolveAppleSnapshotPresentationSourceRoot(root), packagedSource);
});

test('computeRunnerSourceFingerprint covers the shared snapshot presentation sources', () => {
  const root = makeTempRoot();
  fs.mkdirSync(path.join(root, 'apple', 'runner', 'AgentDeviceRunner'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apple', 'snapshot-presentation', 'Sources'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'apple', 'runner', 'AgentDeviceRunner', 'Runner.swift'),
    'runner\n',
  );
  const sharedSource = path.join(
    root,
    'apple',
    'snapshot-presentation',
    'Sources',
    'Presentation.swift',
  );
  fs.writeFileSync(sharedSource, 'shared-one\n');

  const before = computeRunnerSourceFingerprint(root);
  fs.writeFileSync(sharedSource, 'shared-two-changed\n');

  assert.notEqual(computeRunnerSourceFingerprint(root), before);
});

test('computeRunnerSourceFingerprint ignores development-only SwiftPM trees but keeps runner unit tests', () => {
  const root = makeTempRoot();
  const runnerRoot = path.join(root, 'apple', 'runner', 'AgentDeviceRunner');
  const runnerUnitTest = path.join(
    runnerRoot,
    'AgentDeviceRunnerUITests',
    'UnitTests',
    'Invariant.swift',
  );
  const sharedRoot = path.join(root, 'apple', 'snapshot-presentation');
  fs.mkdirSync(path.dirname(runnerUnitTest), { recursive: true });
  fs.mkdirSync(path.join(sharedRoot, 'Sources'), { recursive: true });
  fs.writeFileSync(path.join(runnerRoot, 'Runner.swift'), 'runner\n');
  fs.writeFileSync(runnerUnitTest, 'unit-one\n');
  fs.writeFileSync(path.join(sharedRoot, 'Sources', 'Presentation.swift'), 'shared\n');

  for (const directory of IGNORED_SOURCE_DIRECTORY_NAMES) {
    const file = path.join(sharedRoot, directory, 'Ignored.swift');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'ignored-one\n');
  }

  const before = computeRunnerSourceFingerprint(root);
  for (const directory of IGNORED_SOURCE_DIRECTORY_NAMES) {
    fs.writeFileSync(path.join(sharedRoot, directory, 'Ignored.swift'), 'ignored-two-changed\n');
  }
  const afterIgnoredChanges = computeRunnerSourceFingerprint(root);
  assert.equal(afterIgnoredChanges, before);

  fs.writeFileSync(runnerUnitTest, 'unit-two-changed\n');

  assert.notEqual(computeRunnerSourceFingerprint(root), afterIgnoredChanges);
});

const IGNORED_SOURCE_DIRECTORY_NAMES = [
  'Tests',
  'SnapshotPresentationConformance',
  '.build',
  '.swiftpm',
  'xcuserdata',
];

function makeTempRoot(): string {
  const root = mkdtempForTestSync('agent-device-runner-source-');
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
