import fs from 'node:fs';

/** Opens a regular final-path file for verified reads, or returns absent. */
export function openVerifiedFileForRead(pathname: string): number | undefined {
  return openVerifiedFile(pathname, fs.constants.O_RDONLY, false);
}

/** Opens or creates a verified regular final-path file with atomic append semantics. */
export function openVerifiedFileForAppend(pathname: string): number {
  return openVerifiedFile(pathname, fs.constants.O_WRONLY | fs.constants.O_APPEND, true)!;
}

/** Opens or creates a verified regular final-path file, then truncates only through that fd. */
export function openVerifiedFileForTruncate(pathname: string): number {
  const descriptor = openVerifiedFile(pathname, fs.constants.O_RDWR, true)!;
  try {
    fs.ftruncateSync(descriptor, 0);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openVerifiedFile(
  pathname: string,
  accessFlags: number,
  create: boolean,
): number | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = attemptVerifiedOpen(pathname, accessFlags, create);
    if (result.status === 'retry') continue;
    return result.status === 'missing' ? undefined : result.descriptor;
  }
  throw new Error(`Final file could not be opened without an identity race: ${pathname}`);
}

type VerifiedOpenAttempt =
  | Readonly<{ status: 'opened'; descriptor: number }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'retry' }>;

function attemptVerifiedOpen(
  pathname: string,
  accessFlags: number,
  create: boolean,
): VerifiedOpenAttempt {
  const before = lstatRegularFile(pathname);
  if (!before && !create) return { status: 'missing' };
  const opened = openCandidate(pathname, accessFlags, before === undefined, create);
  if (typeof opened !== 'number') return opened;
  try {
    assertOpenedIdentity(pathname, opened, before);
    return { status: 'opened', descriptor: opened };
  } catch (error) {
    fs.closeSync(opened);
    throw error;
  }
}

function openCandidate(
  pathname: string,
  accessFlags: number,
  creating: boolean,
  create: boolean,
): number | Readonly<{ status: 'missing' | 'retry' }> {
  try {
    return fs.openSync(
      pathname,
      accessFlags |
        optionalNoFollowFlag() |
        (creating ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0),
      0o600,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const recovery = recoverableOpenFailure(code, creating, create);
    if (recovery) return recovery;
    throw error;
  }
}

function recoverableOpenFailure(
  code: string | undefined,
  creating: boolean,
  create: boolean,
): Readonly<{ status: 'missing' | 'retry' }> | undefined {
  if (code === 'EEXIST') return creating ? { status: 'retry' } : undefined;
  if (code !== 'ENOENT') return undefined;
  if (creating) return undefined;
  return { status: create ? 'retry' : 'missing' };
}

function assertOpenedIdentity(pathname: string, descriptor: number, before?: fs.Stats): void {
  const opened = fs.fstatSync(descriptor);
  const after = lstatRegularFile(pathname);
  if (!opened.isFile()) throw identityChangedError(pathname);
  if (!after) throw identityChangedError(pathname);
  if (!sameFile(opened, after)) throw identityChangedError(pathname);
  if (before && !sameFile(before, opened)) throw identityChangedError(pathname);
}

function identityChangedError(pathname: string): Error {
  return new Error(`Final file identity changed while it was opened: ${pathname}`);
}

function lstatRegularFile(pathname: string): fs.Stats | undefined {
  try {
    const stats = fs.lstatSync(pathname);
    if (!stats.isFile()) throw new Error(`Final path must be a regular file: ${pathname}`);
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function optionalNoFollowFlag(): number {
  const noFollow = fs.constants.O_NOFOLLOW;
  return Number.isInteger(noFollow) && noFollow > 0 ? noFollow : 0;
}
