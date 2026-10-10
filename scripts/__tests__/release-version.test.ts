import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  compareReleaseVersions,
  latestNightlyTag,
  nextDevelopmentVersion,
  nightlyBase,
  nightlyVersion,
  previousReleaseTag,
} from '../release-version.mjs';

test('a nightly previews the release main is building towards', () => {
  const version = nightlyVersion('0.21.25-dev', '20261010', 42);
  assert.equal(version, '0.21.25-nightly.20261010.42');
  assert.equal(nightlyBase(version), '0.21.25');
});

test('a nightly is refused unless main carries a -dev version', () => {
  assert.throws(() => nightlyVersion('0.21.25', '20261010', 1), /X\.Y\.Z-dev/);
  assert.throws(() => nightlyVersion('0.21.25-dev', '2026-10-10', 1), /YYYYMMDD/);
  assert.throws(() => nightlyVersion('0.21.25-dev', '20261010', 0), /positive integer/);
});

test('the latest nightly orders by base, then date, then run number', () => {
  const tags = [
    'v0.21.24',
    'v0.21.25-nightly.20261009.9',
    'v0.21.25-nightly.20261010.10',
    'v0.21.25-nightly.20261010.12',
    'v0.21.24-nightly.20261011.13',
    'evidence/v0.21.26-nightly.20261012.14',
  ];
  assert.equal(latestNightlyTag(tags), 'v0.21.25-nightly.20261010.12');
  assert.equal(latestNightlyTag(['v0.21.24']), null);
});

test('release notes start from the newest older stable tag', () => {
  const tags = ['v0.21.9', 'v0.21.23', 'v0.21.24', 'v0.21.25-nightly.20261010.1', 'v0.22.0'];
  assert.equal(previousReleaseTag(tags, '0.21.25'), 'v0.21.24');
  assert.equal(previousReleaseTag(tags, '0.21.10'), 'v0.21.9');
  assert.equal(previousReleaseTag(tags, '0.1.0'), null);
});

test('main moves past a release unless it already builds towards a later one', () => {
  assert.equal(nextDevelopmentVersion('0.21.25-dev', '0.21.25'), '0.21.26-dev');
  assert.equal(nextDevelopmentVersion('0.21.25-dev', '0.22.0'), '0.22.1-dev');
  assert.equal(nextDevelopmentVersion('0.22.0-dev', '0.21.25'), '0.22.0-dev');
  assert.throws(() => nextDevelopmentVersion('0.21.25', '0.21.25'), /X\.Y\.Z-dev/);
});

test('release versions compare numerically per segment', () => {
  assert.ok(compareReleaseVersions('0.21.10', '0.21.9') > 0);
  assert.ok(compareReleaseVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareReleaseVersions('0.21.25', '0.21.25'), 0);
  assert.throws(() => compareReleaseVersions('0.21.25-dev', '0.21.25'), /release version/);
});
