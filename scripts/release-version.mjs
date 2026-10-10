import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Version strings across the release channels. `main` carries `X.Y.Z-dev`, naming the release
// it is building towards; a nightly publishes that base as `X.Y.Z-nightly.<YYYYMMDD>.<run>`; a
// stable release publishes a tagged commit on `main` as `X.Y.Z`. Registry scanners diff the tool surface
// per version string, so neither `main` nor a nightly may ever carry a published stable version.
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const DEVELOPMENT = /^(\d+)\.(\d+)\.(\d+)-dev$/;
const NIGHTLY = /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

export function isReleaseVersion(version) {
  return RELEASE.test(version);
}

export function compareReleaseVersions(left, right) {
  const a = releaseParts(left);
  const b = releaseParts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function nightlyVersion(developmentVersion, date, runNumber) {
  const match = DEVELOPMENT.exec(developmentVersion);
  if (!match) throw new Error(`main must carry an X.Y.Z-dev version, got ${developmentVersion}.`);
  if (!/^\d{8}$/.test(date)) throw new Error(`Nightly date must be YYYYMMDD, got ${date}.`);
  if (!/^[1-9]\d*$/.test(String(runNumber))) {
    throw new Error(`Nightly run number must be a positive integer, got ${runNumber}.`);
  }
  return `${match.slice(1, 4).join('.')}-nightly.${date}.${runNumber}`;
}

/** The `X.Y.Z` release a nightly previews. */
export function nightlyBase(version) {
  const match = NIGHTLY.exec(version);
  if (!match) throw new Error(`${version} is not a nightly version.`);
  return match.slice(1, 4).join('.');
}

/**
 * Nightly tags live outside `v*`, which only repository admins may create: the release workflow
 * tags each nightly itself, and no nightly tag ref may deploy to the npm-publish environment.
 */
const NIGHTLY_TAG_PREFIX = 'nightly/v';

/** The newest `nightly/vX.Y.Z-nightly.<date>.<run>` tag, ordered by base, then date, then run. */
export function latestNightlyTag(tags) {
  const nightlies = tags
    .filter((tag) => tag.startsWith(NIGHTLY_TAG_PREFIX))
    .map((tag) => ({ tag, match: NIGHTLY.exec(tag.slice(NIGHTLY_TAG_PREFIX.length)) }))
    .filter((entry) => entry.match);
  nightlies.sort((a, b) => {
    const [left, right] = [a.match, b.match].map((match) => match.slice(1).map(Number));
    return right.reduce((order, part, index) => order || part - left[index], 0);
  });
  return nightlies[0]?.tag ?? null;
}

/** The newest `vX.Y.Z` tag older than `version`, which bounds its generated release notes. */
export function previousReleaseTag(tags, version) {
  return (
    tags
      .filter((tag) => tag.startsWith('v') && RELEASE.test(tag.slice(1)))
      .filter((tag) => compareReleaseVersions(tag.slice(1), version) < 0)
      .sort((a, b) => compareReleaseVersions(b.slice(1), a.slice(1)))[0] ?? null
  );
}

/**
 * The `-dev` version `main` moves to once `released` is published. A `main` already building
 * towards a later release keeps its version; otherwise it targets the next patch.
 */
export function nextDevelopmentVersion(mainVersion, released) {
  const match = DEVELOPMENT.exec(mainVersion);
  if (!match) throw new Error(`main must carry an X.Y.Z-dev version, got ${mainVersion}.`);
  const base = match.slice(1, 4).join('.');
  if (compareReleaseVersions(base, released) > 0) return mainVersion;
  const [major, minor, patch] = releaseParts(released);
  return `${major}.${minor}.${patch + 1}-dev`;
}

function releaseParts(version) {
  const match = RELEASE.exec(version);
  if (!match) throw new Error(`${version} is not an X.Y.Z release version.`);
  return match.slice(1, 4).map(Number);
}

/** Writes `version` to the root, every public workspace package, and the MCP metadata. */
function stampVersion(root, version) {
  if (![RELEASE, DEVELOPMENT, NIGHTLY].some((pattern) => pattern.test(version))) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const packagePath = path.join(root, 'package.json');
  const raw = fs.readFileSync(packagePath, 'utf8');
  const versionField = `"version": "${JSON.parse(raw).version}"`;
  if (raw.split(versionField).length !== 2) {
    throw new Error(`Expected exactly one ${versionField} in package.json.`);
  }
  fs.writeFileSync(packagePath, raw.replace(versionField, `"version": "${version}"`));
  for (const script of ['release-workspace.mjs', 'sync-mcp-metadata.mjs']) {
    const args = [path.join(root, 'scripts', script)];
    if (script === 'release-workspace.mjs') args.push('sync');
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  }
}

function readRootVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function main([command, ...args]) {
  const root = process.cwd();
  if (command === 'nightly' && args.length === 2) {
    process.stdout.write(`${nightlyVersion(readRootVersion(root), args[0], args[1])}\n`);
  } else if (command === 'stamp' && args.length === 1) {
    stampVersion(root, args[0]);
  } else if (command === 'advance' && args.length === 1) {
    const next = nextDevelopmentVersion(readRootVersion(root), args[0]);
    if (next !== readRootVersion(root)) stampVersion(root, next);
    process.stdout.write(`${next}\n`);
  } else {
    throw new Error(
      'Usage: node scripts/release-version.mjs <nightly <YYYYMMDD> <run>|stamp <version>|advance <released>>',
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
