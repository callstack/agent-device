import fs from 'node:fs';
import { vi } from 'vitest';

/**
 * Some other local user: not the one running the suite, and not root.
 *
 * Ownership is judged against this process's own uid, so naming a fixed id only makes an entry foreign while the
 * suite stands somewhere else: CI runs a suite as `nobody` (65534), and there a hard-coded 65534 makes every
 * "foreign" case this user's own directory, so the ownership boundary is asserted nowhere at all. The same rule
 * is written in host-kit's `internal/atomic-file-host.fixtures.ts`; host-kit's tests may not reach test-kit, and
 * one package may not publish test support to another (R83), so each keeps its own copy — change both together.
 */
export const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

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
export function serveHostOwnership(
  owners: Readonly<Record<string, number>>,
  moved?: Readonly<{ throughDescriptorOnly: boolean }>,
): HostOwnershipProbe {
  // Captured before the spies are installed, so a forwarded call reaches the host and not this fixture.
  const real = {
    lstat: fs.lstatSync.bind(fs),
    stat: fs.statSync.bind(fs),
    open: fs.openSync.bind(fs),
    fstat: fs.fstatSync.bind(fs),
    close: fs.closeSync.bind(fs),
  };
  const openedOn = new Map<number, string>();
  const openedNames: string[] = [];
  const closedDescriptors: number[] = [];
  // Ids come back as bigint or as numbers depending on the caller, so a moved id keeps that type.
  const reuid = <S extends { uid: number | bigint }>(stats: S, pathname: string | undefined): S => {
    const uid = pathname === undefined ? undefined : owners[pathname];
    if (uid === undefined || BigInt(stats.uid) === BigInt(uid)) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      uid: typeof stats.uid === 'bigint' ? BigInt(uid) : uid,
    }) as S;
  };
  // `throughDescriptorOnly` moves the id of the DESCRIPTOR an open reached and nothing else: the shape of
  // a name swapped for a foreign entry between the `lstat` and the open, so only what a descriptor answers
  // sees it, and the name still answers this process's own id.
  if (moved?.throughDescriptorOnly !== true) {
    vi.spyOn(fs, 'lstatSync').mockImplementation(((name: never, ...rest: never[]) =>
      reuid(real.lstat(name, ...rest), String(name))) as typeof fs.lstatSync);
    vi.spyOn(fs, 'statSync').mockImplementation(((name: never, ...rest: never[]) =>
      reuid(real.stat(name, ...rest), String(name))) as typeof fs.statSync);
  }
  vi.spyOn(fs, 'openSync').mockImplementation(((name: never, ...rest: never[]) => {
    const descriptor = Reflect.apply(real.open, fs, [name, ...rest]) as number;
    openedOn.set(descriptor, String(name));
    openedNames.push(String(name));
    return descriptor;
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: never, ...rest: never[]) =>
    reuid(
      Reflect.apply(real.fstat, fs, [fd, ...rest]) as fs.Stats,
      typeof fd === 'number' ? openedOn.get(fd) : undefined,
    )) as typeof fs.fstatSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(((fd: never, ...rest: never[]) => {
    if (typeof fd === 'number') closedDescriptors.push(fd);
    return Reflect.apply(real.close, fs, [fd, ...rest]) as void;
  }) as typeof fs.closeSync);
  return {
    openedNames: () => [...openedNames],
    closedDescriptors: () => [...closedDescriptors],
    descriptorFor: (target: string) => [...openedOn].find(([, name]) => name === target)?.[0],
  };
}

/**
 * What {@link serveHostOwnership} also watched, for a rule that has to answer about a DESCRIPTOR rather than
 * a name: which names were opened, in order, and which descriptors were closed. A caller proves a descent
 * stopped by the names that were NOT opened, and proves a descriptor did not leak by finding it closed.
 */
export type HostOwnershipProbe = Readonly<{
  openedNames: () => readonly string[];
  closedDescriptors: () => readonly number[];
  descriptorFor: (target: string) => number | undefined;
}>;
