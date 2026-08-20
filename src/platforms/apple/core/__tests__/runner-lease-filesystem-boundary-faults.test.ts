import path from 'node:path';
import { afterEach, vi } from 'vitest';
import {
  registerFilesystemBoundaryMatrix,
  type FilesystemBoundaryFixture,
  type FilesystemBoundaryOwner,
} from '../../../../__tests__/test-utils/filesystem-boundary-faults.ts';
import { makeRunnerLease } from './runner-session-fixtures.ts';
import { RUNNER_OWNER_TOKEN, writeRunnerLease } from '../runner/runner-lease.ts';

type RunnerFilesystemBoundaryOwner = 'runner-lease';
const DEVICE_ID = 'filesystem-fault-runner';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
});

const RUNNER_FILESYSTEM_BOUNDARY_OWNERS = {
  'runner-lease': createRunnerLeaseFixture,
} as const satisfies Record<RunnerFilesystemBoundaryOwner, FilesystemBoundaryOwner>;

registerFilesystemBoundaryMatrix(RUNNER_FILESYSTEM_BOUNDARY_OWNERS, 'runner');

function createRunnerLeaseFixture(root: string): FilesystemBoundaryFixture {
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = root;
  const targetPath = path.join(root, `${DEVICE_ID}.json`);
  const lease = makeRunnerLease({
    deviceId: DEVICE_ID,
    ownerToken: RUNNER_OWNER_TOKEN,
  });

  return {
    targetPath,
    run: () => writeRunnerLease(lease),
    expected: 'throw',
  };
}
