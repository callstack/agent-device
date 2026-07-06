import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  resolveAppleRunnerProjectPath,
  resolveAppleRunnerSourceRoot,
} from '../runner/runner-source.ts';

test('resolveAppleRunnerSourceRoot prefers checkout source over packaged source', () => {
  const root = makeTempRoot();
  const checkoutSource = path.join(root, 'apple-runner', 'AgentDeviceRunner');
  const packagedSource = path.join(root, 'dist', 'apple-runner', 'AgentDeviceRunner');
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
  const packagedSource = path.join(root, 'dist', 'apple-runner', 'AgentDeviceRunner');
  fs.mkdirSync(path.join(packagedSource, 'AgentDeviceRunner.xcodeproj'), { recursive: true });

  assert.equal(resolveAppleRunnerSourceRoot(root), packagedSource);
  assert.equal(
    resolveAppleRunnerProjectPath(root),
    path.join(packagedSource, 'AgentDeviceRunner.xcodeproj'),
  );
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runner-source-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
