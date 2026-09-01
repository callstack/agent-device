import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi, afterEach } from 'vitest';
import { runnerOwnerToken, writeRunnerLease } from '../runner-lease.ts';
import { makeRunnerLease } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// The package-local half of the filesystem boundary-fault matrix
// (src/__tests__/test-utils/filesystem-boundary-faults.ts): the root harness
// cannot be imported across the package boundary, and `writeRunnerLease` is
// the one atomic publisher that moved here. The contract under test is the
// same: a fault at the write or rename step surfaces its errno and leaves no
// unpublished temporary file behind. The real `publishFileSync` runs via the
// test host's real defaults.

type FaultPoint = 'write' | 'rename';
const ERRNOS = ['EIO', 'ENOSPC', 'EMFILE'] as const;
const FAULT_POINTS: readonly FaultPoint[] = ['write', 'rename'];
const DEVICE_ID = 'filesystem-fault-runner';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
});

/** Mirrors the canonical same-directory temp-path shape of @agent-device/host-kit/file. */
function isPublishTemporaryPath(value: unknown, destination: string): boolean {
  if (typeof value !== 'string') return false;
  if (path.dirname(value) !== path.dirname(destination)) return false;
  const name = path.basename(value);
  return name.startsWith(`.${path.basename(destination)}.`) && name.endsWith('.tmp');
}

function installFault(options: {
  faultPoint: FaultPoint;
  errno: (typeof ERRNOS)[number];
  targetPath: string;
}): { wasInjected: () => boolean } {
  const failure = new Error(`injected filesystem ${options.errno}`) as NodeJS.ErrnoException;
  failure.code = options.errno;
  let injected = false;
  if (options.faultPoint === 'write') {
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (isPublishTemporaryPath(args[0], options.targetPath)) {
        injected = true;
        Reflect.apply(originalWriteFileSync, fs, args);
        throw failure;
      }
      return Reflect.apply(originalWriteFileSync, fs, args);
    });
  } else {
    const originalRenameSync = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      const touchesTarget = [args[0], args[1]].some(
        (value) =>
          value === options.targetPath || isPublishTemporaryPath(value, options.targetPath),
      );
      if (touchesTarget) {
        injected = true;
        throw failure;
      }
      return Reflect.apply(originalRenameSync, fs, args);
    });
  }
  return { wasInjected: () => injected };
}

function listTemporaryFiles(root: string): string[] {
  const temporaryFiles: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      temporaryFiles.push(path.join(entry.parentPath, entry.name));
    }
  }
  return temporaryFiles;
}

for (const faultPoint of FAULT_POINTS) {
  for (const errno of ERRNOS) {
    test(`runner-lease ${faultPoint} ${errno} surfaces the errno and leaves no unpublished temporary file`, () => {
      const root = mkdtempForTestSync(`apple-runner-lease-boundary-`);
      process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = root;
      const targetPath = path.join(root, `${DEVICE_ID}.json`);
      const lease = makeRunnerLease({ deviceId: DEVICE_ID, ownerToken: runnerOwnerToken() });
      const fault = installFault({ faultPoint, errno, targetPath });

      let thrown: unknown;
      try {
        writeRunnerLease(lease);
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown, `runner-lease should surface ${errno}`);
      assert.equal((thrown as NodeJS.ErrnoException).code, errno);
      assert.equal(fault.wasInjected(), true, `runner-lease ${faultPoint} fault was injected`);
      assert.equal(fs.existsSync(targetPath), false);
      assert.deepEqual(listTemporaryFiles(root), []);
    });
  }
}
