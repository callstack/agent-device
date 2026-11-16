// Whether a destination's parent can be RESOLVED at all, what host-kit creates on the way to it, and what
// a publish does when the walk stops short of it (#4565). Every name the path spells is resolved one step
// at a time the way the kernel walks it, so a `..` is only answerable once the directory it steps back
// from exists.
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ancestryRoot as root,
  directoryWith,
  expectUntrusted,
  modeOf,
  publish,
  withSharedUmask,
} from './atomic-file-host.fixtures.ts';
import { assertPrivateScriptDestination, prepareScriptDestination } from './atomic-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

skipOnWindows(
  'refuses a destination that steps back out of a missing directory, and creates none',
  () => {
    // The walk ends at `missing`, with two steps up still queued. The kernel cannot apply them until
    // `missing` exists, while a recursive `mkdir` resolves the same spelling as text and builds
    // `<root>/shared/recordings` — a directory the walk never judged, where any local user can write. So a
    // destination that would be resolved by creating it is refused BEFORE anything is created, which is the
    // promise the docs make for a refused destination.
    const directory = root();
    const privateDir = directoryWith(path.join(directory, 'private'), 0o700);
    const shared = directoryWith(path.join(directory, 'shared'), 0o777);
    // Spelled by hand, because `path.join` folds a `..` away and the folded name is a DIFFERENT
    // destination: `<root>/shared/recordings`, which the kernel reaches without ever looking at `private`.
    const destination = `${privateDir}/missing/../../shared/recordings/journey.ad`;

    expectUntrusted(() => publish(destination), 'unresolvable_parent', privateDir);
    expectUntrusted(() => prepareScriptDestination(destination), 'unresolvable_parent', privateDir);
    expect(fs.readdirSync(privateDir)).toEqual([]);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows('accepts a destination that steps back over directories that all exist', () => {
  // The other half of the rule: a `..` the kernel CAN apply is applied, and the directory it lands in is
  // judged on its own. `here/nested` stands, so both steps up resolve and the sibling `there` is entered
  // and published into.
  const directory = root();
  const here = directoryWith(path.join(directory, 'here'), 0o700);
  fs.mkdirSync(path.join(here, 'nested'));
  const there = directoryWith(path.join(directory, 'there'), 0o700);

  publish(`${here}/nested/../../there/journey.ad`);

  expect(fs.readFileSync(path.join(there, 'journey.ad'), 'utf8')).toBe('context\n');
  expect(fs.readdirSync(here)).toEqual(['nested']);
});

skipOnWindows('creates a missing parent at 0700 on a shared umask and publishes into it', () => {
  // The shape that used to refuse itself: on a umask-002 host a mode-less `mkdir` makes the new parent
  // 0775, and the check that judges it then refuses the very directory the publish just created, with the
  // directory left behind. host-kit creates at 0700 and a recursive `mkdir` applies that mode to every
  // level it makes, so each new directory passes the check it is judged by.
  const home = directoryWith(path.join(root(), 'home'), 0o700);
  const recordings = path.join(home, 'workflows', 'recordings');
  const destination = path.join(recordings, 'journey.ad');

  withSharedUmask(() => publish(destination));

  expect(fs.readFileSync(destination, 'utf8')).toBe('context\n');
  expect(modeOf(path.join(home, 'workflows'))).toBe(0o700);
  expect(modeOf(recordings)).toBe(0o700);
});

skipOnWindows('answers the created directory as the one to publish into', () => {
  // The creation call answers the directory the SECOND walk judged, spelled from that directory: under the
  // shared umask, that answer is what a caller that stages its own bytes must stage in.
  const home = directoryWith(path.join(root(), 'home'), 0o700);
  const destination = path.join(home, 'nested', 'deeper', 'journey.ad');

  let judged = '';
  withSharedUmask(() => {
    judged = prepareScriptDestination(destination);
  });

  expect(judged).toBe(path.join(home, 'nested', 'deeper'));
  expect(modeOf(path.join(home, 'nested'))).toBe(0o700);
  expect(modeOf(judged)).toBe(0o700);
});

skipOnWindows('refuses a destination whose parent does not exist, and publishes nowhere', () => {
  // `assertPrivateScriptDestination` creates nothing, so a walk that stopped at an absent name has no
  // answer to publish into. The nearest ancestor it did reach would be a file the caller never asked
  // for: `root/journey.ad` instead of `root/missing/journey.ad`.
  const directory = root();
  const missing = path.join(directory, 'missing');
  const destination = path.join(missing, 'journey.ad');

  expectUntrusted(
    () => assertPrivateScriptDestination(destination),
    'unreachable_parent',
    directory,
  );
  expect(fs.readdirSync(directory)).toEqual([]);
});
