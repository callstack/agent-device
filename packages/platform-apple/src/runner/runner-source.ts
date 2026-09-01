import fs from 'node:fs';
import path from 'node:path';

const APPLE_RUNNER_SOURCE_ROOT = path.join('apple', 'runner', 'AgentDeviceRunner');
const PACKAGED_APPLE_RUNNER_SOURCE_ROOT = path.join('dist', 'apple', 'runner', 'AgentDeviceRunner');
const APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT = path.join('apple', 'snapshot-presentation');
const PACKAGED_APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT = path.join(
  'dist',
  'apple',
  'snapshot-presentation',
);

export function resolveAppleRunnerSourceRoot(projectRoot: string): string {
  const checkoutSourceRoot = path.join(projectRoot, APPLE_RUNNER_SOURCE_ROOT);
  if (fs.existsSync(checkoutSourceRoot)) {
    return checkoutSourceRoot;
  }
  return path.join(projectRoot, PACKAGED_APPLE_RUNNER_SOURCE_ROOT);
}

export function resolveAppleRunnerProjectPath(projectRoot: string): string {
  return path.join(resolveAppleRunnerSourceRoot(projectRoot), 'AgentDeviceRunner.xcodeproj');
}

export function resolveAppleSnapshotPresentationSourceRoot(projectRoot: string): string {
  const checkoutSourceRoot = path.join(projectRoot, APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT);
  if (fs.existsSync(checkoutSourceRoot)) {
    return checkoutSourceRoot;
  }
  return path.join(projectRoot, PACKAGED_APPLE_SNAPSHOT_PRESENTATION_SOURCE_ROOT);
}
