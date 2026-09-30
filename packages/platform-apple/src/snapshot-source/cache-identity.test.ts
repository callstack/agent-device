import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { createSnapshotSourceHost } from './host.ts';
import { readSnapshotSourceToolchain } from './cache-identity.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import { SnapshotSourceError } from './errors.ts';
import type { SnapshotSourceHost } from './types.ts';

// The retry, deadline, and cancellation behavior this composes lives with the shared identity read
// it delegates to: see `native-build/toolchain-identity.test.ts`. These cases cover only what this
// thin wrapper adds: the simulator runtime, and this bridge's own error shape.

function fakeToolchainHost(
  run: (command: string, args: string[], options: ExecOptions) => ExecResult,
  cpuArch = 'arm64',
): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    cpuArch: async () => cpuArch,
    run: async (command, args, options) => run(command, args, options ?? {}),
  };
}

function toolchainAnswer(command: string, args: string[]): ExecResult {
  if (command === 'xcodebuild') {
    return { stdout: 'Xcode 26.2\nBuild version 17C52', stderr: '', exitCode: 0 };
  }
  if (command === 'sw_vers') {
    return { stdout: args.includes('-buildVersion') ? '24G90' : '15.6', stderr: '', exitCode: 0 };
  }
  throw new Error(`unexpected probe ${command}`);
}

test('the bridge toolchain identity carries the simulator runtime alongside the host identity', async () => {
  const host = fakeToolchainHost(toolchainAnswer);
  const identity = await readSnapshotSourceToolchain(
    host,
    'iOS 26.2',
    createSnapshotSourceDeadline(30_000, undefined),
  );
  assert.equal(identity.xcode, 'Xcode 26.2\nBuild version 17C52');
  assert.equal(identity.architecture, 'arm64');
  assert.equal(identity.simulatorRuntime, 'iOS 26.2');
});

test('a blank simulator runtime is rejected only after the shared identity read succeeds', async () => {
  let probed = false;
  const host = fakeToolchainHost((command, args) => {
    probed = true;
    return toolchainAnswer(command, args);
  });
  await assert.rejects(
    readSnapshotSourceToolchain(host, '   ', createSnapshotSourceDeadline(30_000, undefined)),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotSourceError);
      assert.equal(error.failureKind, 'unsupported');
      assert.equal(error.failureCode, 'simulator-runtime-missing');
      return true;
    },
  );
  assert.equal(probed, true, 'the runtime is only checked after the identity read succeeds');
});

test("an identity failure from the shared toolchain read surfaces as this bridge's own error type", async () => {
  const unsupportedArch = fakeToolchainHost(toolchainAnswer, 'i386');
  await assert.rejects(
    readSnapshotSourceToolchain(
      unsupportedArch,
      'iOS 26.2',
      createSnapshotSourceDeadline(30_000, undefined),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotSourceError);
      assert.equal(error.failureKind, 'unsupported');
      assert.equal(error.failureCode, 'simulator-architecture-unsupported');
      return true;
    },
  );
});
