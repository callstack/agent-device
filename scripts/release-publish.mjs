import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Uploads the tarballs the release build packed and verified, through npm trusted publishing.
// It runs in the only job holding `id-token: write`, so it uses nothing but Node and the npm CLI.
const [directory, version, distTag] = process.argv.slice(2);
if (!directory || !version || !distTag) {
  throw new Error('Usage: node scripts/release-publish.mjs <tarball-dir> <version> <dist-tag>');
}

const [major, minor, patch] = npm(['--version']).trim().split('.').map(Number);
if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
  throw new Error('npm trusted publishing needs npm 11.5.1 or newer.');
}

const tarballs = fs
  .readdirSync(directory)
  .filter((file) => file.endsWith('.tgz'))
  .map((file) => {
    const tarball = path.join(directory, file);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    if (!/^(agent-device|@agent-device\/[a-z0-9-]+)$/.test(manifest.name)) {
      throw new Error(`${file} packs ${manifest.name}, which this release does not own.`);
    }
    if (manifest.version !== version || manifest.private === true) {
      throw new Error(`${file} packs ${manifest.name}@${manifest.version}, not ${version}.`);
    }
    return { tarball, name: manifest.name };
  })
  // Plugins first: the core going live is the signal that the whole release is available.
  .sort((a, b) => Number(a.name === 'agent-device') - Number(b.name === 'agent-device'));
if (!tarballs.some((entry) => entry.name === 'agent-device')) {
  throw new Error(`${directory} has no agent-device tarball.`);
}

const publishArgs = ['--tag', distTag, '--access', 'public'];
for (const { tarball } of tarballs) npm(['publish', tarball, ...publishArgs, '--dry-run']);
for (const { tarball, name } of tarballs) {
  if (isPublished(name)) {
    process.stdout.write(`${name}@${version} is already published; skipping.\n`);
    continue;
  }
  npm(['publish', tarball, ...publishArgs, '--provenance'], 'inherit');
}

function isPublished(name) {
  try {
    return npm(['view', `${name}@${version}`, 'version', '--json']).trim() !== '';
  } catch (error) {
    // npm reports a missing package or version as E404 in its JSON output; anything else is a
    // registry or network failure, which must not be read as "safe to publish".
    if (readErrorCode(error.stdout) === 'E404') return false;
    throw error;
  }
}

function readErrorCode(output) {
  try {
    return JSON.parse(output).error?.code;
  } catch {
    return undefined;
  }
}

function npm(args, stdio = 'pipe') {
  return execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', stdio, 'inherit'] }) ?? '';
}
