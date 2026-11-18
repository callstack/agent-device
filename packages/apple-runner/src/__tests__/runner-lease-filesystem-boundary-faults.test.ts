import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  registerFilesystemBoundaryMatrix,
  type FilesystemBoundaryOwner,
} from '@agent-device/test-kit';
import { runnerOwnerToken, writeRunnerLease } from '../runner-lease.ts';
import { makeRunnerLease } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// `writeRunnerLease` is the one atomic publisher that lives in this package, so its half of the filesystem
// boundary-fault matrix lives here too. The matrix is test-kit's, because the seam it faults is host-kit's: a
// publisher stages a sibling and writes the bytes THROUGH the descriptor it just created, so the fault has to be
// recognised on that descriptor. A spy that matched the sibling's NAME at `writeFileSync` would watch a call the
// publisher no longer makes, report a fault that was never injected, and pass while the publisher went untested.

const DEVICE_ID = 'filesystem-fault-runner';
const LEASE_DIR_ENV = 'AGENT_DEVICE_IOS_RUNNER_LEASE_DIR';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[LEASE_DIR_ENV];
});

const createLeaseFixture: FilesystemBoundaryOwner = (root) => {
  process.env[LEASE_DIR_ENV] = root;
  const lease = makeRunnerLease({ deviceId: DEVICE_ID, ownerToken: runnerOwnerToken() });
  return {
    targetPath: path.join(root, `${DEVICE_ID}.json`),
    run: () => writeRunnerLease(lease),
    expected: 'throw',
  };
};

registerFilesystemBoundaryMatrix(
  { 'runner-lease': createLeaseFixture } as const satisfies Record<
    'runner-lease',
    FilesystemBoundaryOwner
  >,
  'apple-runner',
);

test('a lease write publishes at the lease directory it was routed to', () => {
  // What every fault row above assumes: that the write this fixture runs is a real one at the path the fixture
  // names. A lease that started landing elsewhere would turn each row into a fault injected on nothing.
  const root = mkdtempForTestSync('apple-runner-lease-routing-');
  process.env[LEASE_DIR_ENV] = root;
  const lease = makeRunnerLease({ deviceId: DEVICE_ID, ownerToken: runnerOwnerToken() });

  writeRunnerLease(lease);

  const written = path.join(root, `${DEVICE_ID}.json`);
  assert.equal(JSON.parse(fs.readFileSync(written, 'utf8')).deviceId, DEVICE_ID);
  // The lease carries the runner's listener token, so the entry is this user's alone.
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
});
