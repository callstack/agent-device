import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { makeRunnerLease } from './runner-session-fixtures.ts';
import { RUNNER_OWNER_TOKEN, writeRunnerLease } from '../runner/runner-lease.ts';

type FilesystemErrno = 'EIO' | 'ENOSPC' | 'EMFILE';
type FaultPoint = 'write' | 'rename';
type FaultInjection = { wasInjected: () => boolean };

const FILESYSTEM_ERRNOS: readonly FilesystemErrno[] = ['EIO', 'ENOSPC', 'EMFILE'];
const FAULT_POINTS: readonly FaultPoint[] = ['write', 'rename'];
const DEVICE_ID = 'filesystem-fault-runner';

let leaseRoot: string;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
});

for (const faultPoint of FAULT_POINTS) {
  for (const errno of FILESYSTEM_ERRNOS) {
    test(`runner lease ${faultPoint} ${errno} leaves no unpublished temporary file`, () => {
      leaseRoot = mkdtempForTestSync(`agent-device-runner-lease-boundary-`);
      process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = leaseRoot;
      const targetPath = path.join(leaseRoot, `${DEVICE_ID}.json`);
      const lease = makeRunnerLease({
        deviceId: DEVICE_ID,
        ownerToken: RUNNER_OWNER_TOKEN,
      });
      const fault = installFilesystemFault(faultPoint, errno, targetPath);

      let thrown: unknown;
      try {
        writeRunnerLease(lease);
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown, `runner lease should surface ${errno}`);
      assert.equal((thrown as NodeJS.ErrnoException).code, errno);
      assert.equal(fault.wasInjected(), true, `${faultPoint} fault was injected`);
      assert.equal(fs.existsSync(targetPath), false);
      assert.deepEqual(listTemporaryFiles(leaseRoot), []);
    });
  }
}

function installFilesystemFault(
  faultPoint: FaultPoint,
  errno: FilesystemErrno,
  targetPath: string,
): FaultInjection {
  const failure = createErrno(errno);
  let injected = false;
  const matchesTarget = (value: unknown): boolean => {
    const candidate = String(value);
    const targetName = path.basename(targetPath);
    const candidateName = path.basename(candidate);
    return (
      candidate === targetPath ||
      candidateName.startsWith(`.${targetName}.`) ||
      candidateName.startsWith(`${targetName}.`)
    );
  };

  if (faultPoint === 'write') {
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (matchesTarget(args[0])) {
        injected = true;
        throw failure;
      }
      return Reflect.apply(originalWriteFileSync, fs, args);
    });
    return { wasInjected: () => injected };
  }

  const originalRenameSync = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
    if (matchesTarget(args[0]) || matchesTarget(args[1])) {
      injected = true;
      throw failure;
    }
    return Reflect.apply(originalRenameSync, fs, args);
  });
  return { wasInjected: () => injected };
}

function createErrno(errno: FilesystemErrno): NodeJS.ErrnoException {
  const error = new Error(`injected filesystem ${errno}`) as NodeJS.ErrnoException;
  error.code = errno;
  return error;
}

function listTemporaryFiles(root: string): string[] {
  const temporaryFiles: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.endsWith('.tmp')) temporaryFiles.push(path.join(root, entry.name));
  }
  return temporaryFiles;
}
