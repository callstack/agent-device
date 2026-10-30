import assert from 'node:assert/strict';
import { test } from 'vitest';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  resolveRunnerBuildDestination,
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDestination,
} from '../apple-runner-platform.ts';
import { MACOS_DEVICE } from './device-fixtures.ts';

// The host names the machine's CPU, not Node's: a Node running as x64 under Rosetta on an Apple
// silicon Mac reports `arm64` here (`host-kit`'s `host-process-cpu-arch.test.ts` pins that), and the
// runner builds and launches for what the host reports.
function macosDestinations(): string[] {
  return [
    resolveRunnerDestination(MACOS_DEVICE),
    resolveRunnerBuildDestination(MACOS_DEVICE),
    resolveRunnerBuildDestinationFamily(MACOS_DEVICE),
  ];
}

test('the macOS runner destinations name arm64 when the host CPU is arm64', () => {
  appleRunnerTestHost.update({ readHostCpuArchSync: () => 'arm64' });
  for (const destination of macosDestinations()) {
    assert.equal(destination, 'platform=macOS,arch=arm64');
  }
});

test('the macOS runner destinations name x86_64 when the host CPU is not arm64', () => {
  appleRunnerTestHost.update({ readHostCpuArchSync: () => 'x86_64' });
  for (const destination of macosDestinations()) {
    assert.equal(destination, 'platform=macOS,arch=x86_64');
  }
});
