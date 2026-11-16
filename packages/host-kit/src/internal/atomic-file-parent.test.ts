// Whether a destination's parent can be RESOLVED at all, and what the publish does when the walk stops
// short of it (#4565). Every name the path spells is resolved one step at a time the way the kernel walks
// it, so a `..` is only answerable once the directory it steps back from exists.
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ancestryRoot as root,
  currentGid,
  directoryWith,
  expectUntrusted,
  hostDatabase,
  publish,
  serveGroupDatabase,
} from './atomic-file-host.fixtures.ts';
import { assertPrivateScriptDestination } from './atomic-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

skipOnWindows('refuses a destination that steps back out of a missing directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // The walk ends at `missing`, with two steps up still queued. The kernel cannot apply them until
  // `missing` exists, while a recursive `mkdir` resolves the same spelling as text and builds
  // `<root>/shared/recordings` — a directory the walk never judged, where any local user can write. A
  // destination that would be resolved by creating it is refused, and nothing is created on the way.
  const directory = root();
  const privateDir = directoryWith(path.join(directory, 'private'), 0o700);
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  // Spelled by hand, because `path.join` folds a `..` away and the folded name is a DIFFERENT
  // destination: `<root>/shared/recordings`, which the kernel reaches without ever looking at `private`.
  const destination = `${privateDir}/missing/../../shared/recordings/journey.ad`;

  expectUntrusted(
    () => assertPrivateScriptDestination(destination),
    'unresolvable_parent',
    privateDir,
  );
  expect(fs.readdirSync(privateDir)).toEqual([]);
  expect(fs.readdirSync(shared)).toEqual([]);
});

skipOnWindows('accepts a destination that steps back over directories that all exist', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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

skipOnWindows('refuses a destination whose parent does not exist, and publishes nowhere', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // This publisher creates no directories, so a walk that stopped at an absent name has no answer to
  // publish into. The nearest ancestor it did reach would be a file the caller never asked for:
  // `root/journey.ad` instead of `root/missing/journey.ad`.
  const directory = root();
  const missing = path.join(directory, 'missing');
  const destination = path.join(missing, 'journey.ad');

  expectUntrusted(() => publish(destination), 'unreachable_parent', directory);
  expect(fs.readdirSync(directory)).toEqual([]);
});
