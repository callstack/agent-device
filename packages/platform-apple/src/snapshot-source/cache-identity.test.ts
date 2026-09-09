import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createSnapshotSourceHost } from './host.ts';
import { readSnapshotSourceToolchain } from './cache-identity.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import type { SnapshotSourceHost } from './types.ts';

// Apple's syspolicyd signature scan blocks the first xcodebuild/xcrun exec
// after a fresh macOS host boots for roughly 18 to 19 seconds; the immediate
// next exec of the same tool is instant (#2422). These cases exercise the
// resulting one-retry policy without waiting on a real cold-start stall.

test('a cold-start toolchain probe recovers on retry: the first call exceeds the budget, the second returns immediately', async () => {
  let calls = 0;
  const host = fakeToolchainHost((command, args) => {
    calls += 1;
    if (calls === 1) {
      throw new AppError('COMMAND_FAILED', `${command} timed out after 30000ms`, {
        timeoutMs: 30_000,
      });
    }
    return toolchainAnswer(command, args);
  });

  const identity = await readSnapshotSourceToolchain(
    host,
    'iOS 26.2',
    createSnapshotSourceDeadline(120_000, undefined),
  );

  assert.equal(identity.xcode, 'Xcode 26.2\nBuild version 17C52');
  assert.equal(identity.macosBuild, '24G90');
  assert.equal(identity.architecture, 'arm64');
  assert.equal(identity.simulatorSdk, '26.2');
  // 5 baseline probes (xcodebuild, sw_vers x2, uname, xcrun) plus the one
  // retry that recovered the first, timed-out call.
  assert.equal(calls, 6);
});

test('a toolchain host that never returns still fails at the deadline with the same timeout error', async () => {
  let calls = 0;
  const host = fakeToolchainHost((command) => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', `${command} timed out after 30000ms`, {
      timeoutMs: 30_000,
    });
  });

  await assert.rejects(
    readSnapshotSourceToolchain(host, 'iOS 26.2', createSnapshotSourceDeadline(120_000, undefined)),
    (error: unknown) =>
      error instanceof AppError && error.message === 'xcodebuild timed out after 30000ms',
  );
  // Exactly one retry, not an unbounded loop.
  assert.equal(calls, 2);
});

test('a probe that failed on its own and merely says "timed out" in its message is not retried', async () => {
  let calls = 0;
  const host = fakeToolchainHost((command) => {
    calls += 1;
    // No `timeoutMs` detail: the tool reported its own failure, the exec layer
    // did not kill it at a timeout we asked for. Retrying that just doubles a
    // failure the retry cannot fix.
    throw new AppError('COMMAND_FAILED', `${command} timed out after 10ms`, { cmd: command });
  });

  await assert.rejects(
    readSnapshotSourceToolchain(host, 'iOS 26.2', createSnapshotSourceDeadline(120_000, undefined)),
    (error: unknown) =>
      error instanceof AppError && error.message === 'xcodebuild timed out after 10ms',
  );
  assert.equal(calls, 1);
});

function toolchainAnswer(
  command: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const stdout =
    command === 'xcodebuild'
      ? 'Xcode 26.2\nBuild version 17C52'
      : command === 'sw_vers'
        ? args.includes('-buildVersion')
          ? '24G90'
          : '15.6'
        : command === 'uname'
          ? 'arm64'
          : '26.2';
  return { stdout, stderr: '', exitCode: 0 };
}

function fakeToolchainHost(
  run: (command: string, args: string[]) => { stdout: string; stderr: string; exitCode: number },
): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    run: async (command, args) => run(command, args),
  };
}
