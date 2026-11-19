// The private-ancestry judgement executable state asks the destination walk for: no traversed directory may be
// group- or world-writable, sticky or not, or owned by anyone but root or this user. One walk judges every level,
// links followed, before its first mkdir, so nothing is created under ground it refuses.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { directoryWith, expectUntrusted, FOREIGN_UID } from './script-destination-host.fixtures.ts';
import { prepareScriptDestination } from './script-destination.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;
const PRIVATE = { privateAncestry: true } as const;

let root = '';

beforeEach((context) => {
  // A root with no shared directory above it: the run's checkout-local directory, which the Vitest global setup
  // names only after checking every level from `/`. The run's TMPDIR sits under the sticky /tmp, which this
  // judgement refuses by design.
  const runDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR;
  if (!runDir) {
    if (process.env.CI) throw new Error('This test needs a private checkout ancestry.');
    return context.skip('checkout ancestry not private; private-ancestry tests skipped');
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(runDir, 'host-kit-private-ancestry-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

/** Reports another local user as the owner of `target`; modes and every other path stay what the host says. */
function reportForeignOwner(target: string): void {
  const realLstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: never, ...rest: never[]) => {
    const stats = realLstat(name, ...rest);
    if (String(name) !== target || stats === undefined) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      uid: typeof stats.uid === 'bigint' ? BigInt(FOREIGN_UID) : FOREIGN_UID,
    });
  }) as typeof fs.lstatSync);
}

skipOnWindows.each([
  ['1777', 'world_writable'],
  ['1770', 'shared_group_writable'],
])(
  'a sticky ancestor at mode %s is refused with private ancestry, and nothing is created in it',
  (mode, exposure) => {
    const shared = directoryWith(path.join(root, 'shared'), Number.parseInt(mode, 8));
    const destination = path.join(shared, 'cache', 'v3', 'entry');

    expectUntrusted(() => prepareScriptDestination(destination, PRIVATE), exposure, shared);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows('without private ancestry, the same sticky ancestor is still passed through', () => {
  const shared = directoryWith(path.join(root, 'shared'), 0o1777);

  const { directory } = prepareScriptDestination(path.join(shared, 'cache', 'entry'));

  expect(directory).toBe(path.join(shared, 'cache'));
});

skipOnWindows(
  'a group-writable ancestor is refused with private ancestry, and nothing is created',
  () => {
    const shared = directoryWith(path.join(root, 'group'), 0o770);

    expectUntrusted(
      () => prepareScriptDestination(path.join(shared, 'cache', 'entry'), PRIVATE),
      'shared_group_writable',
      shared,
    );
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows('an ancestor another local user owns is refused with private ancestry', () => {
  const foreign = directoryWith(path.join(root, 'foreign'), 0o700);
  reportForeignOwner(foreign);

  expectUntrusted(
    () => prepareScriptDestination(path.join(foreign, 'cache', 'entry'), PRIVATE),
    'foreign_owned',
    foreign,
  );
  expect(fs.readdirSync(foreign)).toEqual([]);
});

skipOnWindows(
  'a link whose target lies under a sticky shared directory is refused there, before anything is created',
  () => {
    const shared = directoryWith(path.join(root, 'shared'), 0o1777);
    const owned = directoryWith(path.join(root, 'owned'), 0o700);
    fs.symlinkSync(path.join(shared, 'missing'), path.join(owned, 'cache'));

    expectUntrusted(
      () => prepareScriptDestination(path.join(owned, 'cache', 'v3', 'entry'), PRIVATE),
      'world_writable',
      shared,
    );
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows(
  'an intermediate link in a sticky shared directory that vanishes mid-walk leaves nothing created there',
  () => {
    // owned/cache -> shared/hop -> elsewhere/target: the hop sits where a temp cleaner can remove it, and does,
    // right after the walk reads the first link. A second, separate walk would then see a missing name in the
    // shared directory and create it; the one judging walk refuses that directory before its first mkdir.
    const shared = directoryWith(path.join(root, 'shared'), 0o1777);
    const owned = directoryWith(path.join(root, 'owned'), 0o700);
    const elsewhere = directoryWith(path.join(root, 'elsewhere'), 0o700);
    const hop = path.join(shared, 'hop');
    fs.symlinkSync(path.join(elsewhere, 'target'), hop);
    fs.symlinkSync(hop, path.join(owned, 'cache'));
    const realReadlink = fs.readlinkSync.bind(fs);
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((name: never, ...rest: never[]) => {
      const target = realReadlink(name, ...rest);
      if (String(name) === path.join(owned, 'cache')) fs.unlinkSync(hop);
      return target;
    }) as typeof fs.readlinkSync);

    expectUntrusted(
      () => prepareScriptDestination(path.join(owned, 'cache', 'v3', 'entry'), PRIVATE),
      'world_writable',
      shared,
    );
    expect(fs.readdirSync(shared)).toEqual([]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  },
);
