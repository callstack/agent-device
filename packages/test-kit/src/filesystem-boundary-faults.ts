import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';

export type FilesystemErrno = 'EIO' | 'ENOSPC' | 'EMFILE';
export type FilesystemFaultPoint = 'write' | 'rename';

export type FilesystemBoundaryFixture = {
  targetPath: string;
  run: () => unknown | Promise<unknown>;
  expected: 'throw' | 'return';
  verifyReturn?: (value: unknown, errno: FilesystemErrno) => void;
};

export type FilesystemBoundaryOwner = (root: string) => FilesystemBoundaryFixture;

const FILESYSTEM_ERRNOS: readonly FilesystemErrno[] = ['EIO', 'ENOSPC', 'EMFILE'];
const FILESYSTEM_FAULT_POINTS: readonly FilesystemFaultPoint[] = ['write', 'rename'];

/** Registers every fault row for a typed owner table. Missing required owners fail typechecking. */
export function registerFilesystemBoundaryMatrix(
  owners: Readonly<Record<string, FilesystemBoundaryOwner>>,
  prefix: string,
): void {
  for (const [ownerName, createFixture] of Object.entries(owners)) {
    for (const faultPoint of FILESYSTEM_FAULT_POINTS) {
      for (const errno of FILESYSTEM_ERRNOS) {
        test(`${prefix} ${ownerName} ${faultPoint} ${errno} leaves no unpublished temporary file`, async () => {
          const root = mkdtempForTestSync(
            `agent-device-${prefix}-${ownerName.replaceAll('/', '-')}-boundary-`,
          );
          const fixture = createFixture(root);
          const fault = installFilesystemFault({
            faultPoint,
            errno,
            targetPath: fixture.targetPath,
          });

          let value: unknown;
          let thrown: unknown;
          try {
            value = await fixture.run();
          } catch (error) {
            thrown = error;
          }

          if (fixture.expected === 'throw') {
            assert.ok(thrown, `${ownerName} should surface ${errno}`);
            assert.equal((thrown as NodeJS.ErrnoException).code, errno);
          } else {
            assert.equal(thrown, undefined);
            fixture.verifyReturn?.(value, errno);
          }
          assert.equal(fault.wasInjected(), true, `${ownerName} ${faultPoint} fault was injected`);
          assert.equal(fs.existsSync(fixture.targetPath), false);
          assert.deepEqual(listTemporaryFiles(root), []);
        });
      }
    }
  }
}

function installFilesystemFault(options: {
  faultPoint: FilesystemFaultPoint;
  errno: FilesystemErrno;
  targetPath: string;
}): { wasInjected: () => boolean } {
  const failure = createErrno(options.errno);
  let injected = false;
  const temporaryDescriptors = new Set<number>();
  const temporaryPath = (value: unknown) => isPublishTemporarySiblingOf(value, options.targetPath);
  const isTargetOrTemporary = (value: unknown): boolean =>
    value === options.targetPath || temporaryPath(value);

  if (options.faultPoint === 'write') {
    const originalOpenSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const descriptor = Reflect.apply(originalOpenSync, fs, args);
      if (temporaryPath(args[0])) {
        temporaryDescriptors.add(descriptor);
      }
      return descriptor;
    });

    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      const destination = args[0];
      const writesPublishedTemporary =
        temporaryPath(destination) ||
        (typeof destination === 'number' && temporaryDescriptors.has(destination));
      if (writesPublishedTemporary) {
        injected = true;
        Reflect.apply(originalWriteFileSync, fs, args);
        throw failure;
      }
      return Reflect.apply(originalWriteFileSync, fs, args);
    });
  } else {
    const originalRenameSync = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      if (isTargetOrTemporary(args[0]) || isTargetOrTemporary(args[1])) {
        injected = true;
        throw failure;
      }
      return Reflect.apply(originalRenameSync, fs, args);
    });
  }

  return { wasInjected: () => injected };
}

/**
 * Whether a value is the temporary sibling a publish makes for `targetPath`, by NAME and by directory.
 *
 * The directory is asked as device and inode, not as text: a publisher that judges ground stages its sibling
 * in the PHYSICAL directory it judged, and a spelling through a symbolic link (`/var` on macOS) or a `..`
 * behind a link is one directory in the filesystem and two in text. Comparing the text would leave the real
 * sibling unmatched.
 */
export function isPublishTemporarySiblingOf(value: unknown, targetPath: string): boolean {
  if (typeof value !== 'string' || !value.endsWith('.tmp')) return false;
  const name = path.basename(value);
  const prefix = `.${path.basename(targetPath)}.`;
  if (!name.startsWith(prefix) || name.length <= prefix.length + 1) return false;
  const directory = path.dirname(value);
  const spelled = path.dirname(targetPath);
  if (directory === spelled) return true;
  const expected = statOrNull(spelled);
  const seen = statOrNull(directory);
  return (
    expected !== undefined &&
    seen !== undefined &&
    seen.dev === expected.dev &&
    seen.ino === expected.ino
  );
}

function statOrNull(pathname: string): fs.Stats | undefined {
  try {
    return fs.statSync(pathname);
  } catch {
    return undefined;
  }
}

function createErrno(errno: FilesystemErrno): NodeJS.ErrnoException {
  const error = new Error(`injected filesystem ${errno}`) as NodeJS.ErrnoException;
  error.code = errno;
  return error;
}

function listTemporaryFiles(root: string): string[] {
  const temporaryFiles: string[] = [];

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith('.tmp')) temporaryFiles.push(entryPath);
    }
  }

  visit(root);
  return temporaryFiles;
}
