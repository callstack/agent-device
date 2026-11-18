import fs from 'node:fs';
import { vi } from 'vitest';

/**
 * Some other local user: not the one running the suite, and not root.
 *
 * Ownership is judged against this process's own uid, so naming a fixed id only makes an entry foreign while the
 * suite stands somewhere else: CI runs a suite as `nobody` (65534), and there a hard-coded 65534 makes every
 * "foreign" case this user's own directory, so the ownership boundary is asserted nowhere at all. The same rule
 * is written in host-kit's `internal/atomic-file-host.fixtures.ts` and in capture-kit's
 * `recording/swift-cache-trust.test.ts`; packages test-kit depends on may not reach it, and one package may not
 * publish test support to another (R83), so each keeps its own copy — change all three together.
 */
export const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

/**
 * Reports the ids in `owners` for the paths named there, and the real host for every other path, so an
 * ownership rule is decided by the fixture rather than by the account the suite happens to run under.
 *
 * Only the ids move: modes and inode numbers stay what they are on disk. A real foreign owner needs privileges a
 * test does not have — an unprivileged process cannot `chown` — and moving the CALLER's uid instead decides the
 * test by which directories the scratch tree happens to sit under.
 */
export function serveHostOwnership(owners: Readonly<Record<string, number>>): void {
  // Captured before the spies are installed, so a forwarded call reaches the host and not this fixture.
  const real = { lstat: fs.lstatSync.bind(fs), stat: fs.statSync.bind(fs) };
  // Ids come back as bigint or as numbers depending on the caller, so a moved id keeps that type.
  const reuid = <S extends { uid: number | bigint }>(stats: S, pathname: string): S => {
    const uid = owners[pathname];
    if (uid === undefined || BigInt(stats.uid) === BigInt(uid)) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      uid: typeof stats.uid === 'bigint' ? BigInt(uid) : uid,
    }) as S;
  };
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: never, ...rest: never[]) =>
    reuid(real.lstat(name, ...rest), String(name))) as typeof fs.lstatSync);
  vi.spyOn(fs, 'statSync').mockImplementation(((name: never, ...rest: never[]) =>
    reuid(real.stat(name, ...rest), String(name))) as typeof fs.statSync);
}
