import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { createAppleRunnerRuntimeState } from '../../core/runner-owner-state.ts';
import { currentRunnerLeaseOwnerToken, writeRunnerLease } from '../runner-lease.ts';

// Each composed runtime reads its runner configuration from the host it was composed with, not
// from the process (#3794). Two runtimes with different lease directories must resolve their own.
test("each runner runtime resolves its host's runner lease directory, not the process value", () => {
  // The process itself names no lease directory, so the un-composed read below lands on the
  // default home location rather than an operator-set directory.
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  const root = mkdtempForTestSync('apple-runner-lease-host-');
  const dirA = path.join(root, 'a');
  const dirB = path.join(root, 'b');
  const runtimeA = createAppleRunnerRuntimeState({
    env: { ...process.env, AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: dirA },
    cwd: process.cwd(),
  });
  const runtimeB = createAppleRunnerRuntimeState({
    env: { ...process.env, AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: dirB },
    cwd: process.cwd(),
  });

  runtimeA.run(() =>
    writeRunnerLease({
      schemaVersion: 1,
      deviceId: 'device-1',
      ownerToken: 'token-a',
      ownerPid: process.pid,
      ownerStartTime: null,
      sessionId: 'session-a',
      runnerPid: null,
      runnerStartTime: null,
      port: 8100,
      xctestrunPath: path.join(root, 'run.xctestrun'),
      jsonPath: path.join(root, 'run.json'),
      createdAtMs: Date.now(),
    }),
  );

  // A's lease is visible to A and invisible to B: each resolves its own directory.
  expect(runtimeA.run(() => currentRunnerLeaseOwnerToken('device-1'))).toBe('token-a');
  expect(runtimeB.run(() => currentRunnerLeaseOwnerToken('device-1'))).toBeNull();
  // And invisible to the process default, which reads neither override.
  expect(currentRunnerLeaseOwnerToken('device-1')).toBeNull();
  expect(fs.existsSync(path.join(dirA, 'device-1.json'))).toBe(true);
  expect(fs.existsSync(path.join(dirB, 'device-1.json'))).toBe(false);

  runtimeA.dispose();
  runtimeB.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
