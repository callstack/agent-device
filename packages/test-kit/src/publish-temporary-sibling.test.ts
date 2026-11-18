import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { isPublishTemporarySiblingOf } from './filesystem-boundary-faults.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

/**
 * The predicate fault injection and the staging-failure fixture share. A publisher that judges ground stages
 * its temporary sibling in the PHYSICAL directory it judged, so the match is by device and inode: faulting a
 * name that only LOOKS like the sibling, or missing the real one, makes a boundary row vacuous.
 */

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

skipOnWindows('matches a temp sibling reached through a .. that steps back from a link', () => {
  // `home/work -> priv/x`, and the destination is `home/work/../y/journey.ad`. The entry is created in
  // `priv/y`, because `..` steps back from the link's TARGET, so the temp file sits beside it. The
  // destination's own spelling resolves elsewhere — `home/y` — and applying a spelled `..` textually, as
  // `lstat` or `realpathSync` do, answers exactly that. The real temp sibling is then somebody else's file
  // and a planted look-alike beside `home/y` is one of ours.
  const root = fixtureRoot('dotdot');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const homeY = path.join(home, 'y');
  fs.mkdirSync(homeY);
  const privX = path.join(root, 'priv', 'x');
  fs.mkdirSync(privX, { recursive: true });
  const privY = path.join(root, 'priv', 'y');
  fs.mkdirSync(privY);
  fs.symlinkSync(privX, path.join(home, 'work'));
  const destination = `${home}/work/../y/journey.ad`;
  const named = temporaryName('journey.ad');
  const realSibling = path.join(privY, named);
  const lookAlike = path.join(homeY, named);

  expect(isPublishTemporarySiblingOf(realSibling, destination)).toBe(true);
  expect(isPublishTemporarySiblingOf(lookAlike, destination)).toBe(false);
});

skipOnWindows(
  'matches a temp path spelled through the directory the entry is really created in',
  () => {
    // The temp file is a sibling of the destination AS THE FILESYSTEM RESOLVES IT, because that is where the
    // entry is created. A destination spelled through a symbolic link (`/var` on macOS) therefore has its
    // temp file one directory over in text, and a caller that compared the two spellings as strings would
    // call every one of those temp files somebody else's.
    const root = fixtureRoot('alias');
    const physical = path.join(root, 'physical');
    fs.mkdirSync(physical);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(physical, alias);
    const destination = path.join(alias, 'report.json');
    const staged = path.join(fs.realpathSync(physical), temporaryName('report.json'));

    expect(isPublishTemporarySiblingOf(staged, destination)).toBe(true);
    // Still one directory's worth of names: a sibling that is not this destination's temp file is not it.
    expect(
      isPublishTemporarySiblingOf(
        path.join(fs.realpathSync(physical), '.other.1.tmp'),
        destination,
      ),
    ).toBe(false);
  },
);

/** A temp sibling's name as host-kit spells it: a readable stem, a hash of the whole name, then a random tail. */
function temporaryName(name: string): string {
  const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `.${name}.${digest}.${process.pid}-0000.tmp`;
}

function fixtureRoot(label: string): string {
  return mkdtempForTestSync(`agent-device-temp-sibling-${label}-`);
}
