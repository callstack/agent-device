import fs from 'node:fs';
import { vi } from 'vitest';

/** Some other local user: not the one running the suite, and not root. */
export const FOREIGN_UID = 65534;

/**
 * Reports the ids in `owners` for the paths named there, and the real host for every other path, so an
 * ownership rule is decided by the fixture rather than by the account the suite happens to run under.
 *
 * A rule that is about to CHANGE an entry asks the id of the DESCRIPTOR it will change, not of the name it
 * was handed, so the ids are served through `fstat` too — through which path is recorded at `open` time.
 * Only the ids move: modes and inode numbers stay what they are on disk. A real foreign owner needs
 * privileges a test does not have — an unprivileged process cannot `chown` — and moving the CALLER's uid
 * instead decides the test by which directories the scratch tree happens to sit under.
 */
export function serveHostOwnership(owners: Readonly<Record<string, number>>): void {
  // Captured before the spies are installed, so a forwarded call reaches the host and not this fixture.
  const real = {
    lstat: fs.lstatSync.bind(fs),
    stat: fs.statSync.bind(fs),
    open: fs.openSync.bind(fs),
    fstat: fs.fstatSync.bind(fs),
  };
  const openedOn = new Map<number, string>();
  // Ids come back as bigint or as numbers depending on the caller, so a moved id keeps that type.
  const reuid = <S extends { uid: number | bigint }>(stats: S, pathname: string | undefined): S => {
    const uid = pathname === undefined ? undefined : owners[pathname];
    if (uid === undefined || BigInt(stats.uid) === BigInt(uid)) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      uid: typeof stats.uid === 'bigint' ? BigInt(uid) : uid,
    }) as S;
  };
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: never, ...rest: never[]) =>
    reuid(real.lstat(name, ...rest), String(name))) as typeof fs.lstatSync);
  vi.spyOn(fs, 'statSync').mockImplementation(((name: never, ...rest: never[]) =>
    reuid(real.stat(name, ...rest), String(name))) as typeof fs.statSync);
  vi.spyOn(fs, 'openSync').mockImplementation(((name: never, ...rest: never[]) => {
    const descriptor = Reflect.apply(real.open, fs, [name, ...rest]) as number;
    openedOn.set(descriptor, String(name));
    return descriptor;
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: never, ...rest: never[]) =>
    reuid(
      Reflect.apply(real.fstat, fs, [fd, ...rest]) as fs.Stats,
      typeof fd === 'number' ? openedOn.get(fd) : undefined,
    )) as typeof fs.fstatSync);
}
