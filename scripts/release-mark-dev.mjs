import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// The version on main must never equal a published version: registry scanners
// diff the repository's tool surface per version string, so a released number
// left in place while main keeps moving reads as a rug-pull republish
// (AS-012). `postpublish` runs this after all packages publish to move
// main to the next patch with a `-dev` prerelease marker; `--check-release-version`
// is the inverse guard in `prepublishOnly`, refusing to publish a `-dev`
// version because the maintainer has not set the release version yet.
const root = process.cwd();
const checkReleaseVersion = process.argv.includes('--check-release-version');
const packagePath = path.join(root, 'package.json');

const raw = fs.readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(raw);
const version = pkg.version;

if (typeof version !== 'string' || version.length === 0) {
  fail('package.json must define version.');
}

if (checkReleaseVersion) {
  if (version.includes('-')) {
    fail(
      `package.json version ${version} is a prerelease marker. Set the release version first ` +
        '(e.g. `npm version patch`), commit, then publish.',
    );
  }
  runWorkspaceRelease('check');
  process.exit(0);
}

const nextVersion = version.includes('-') ? version : markRootAsDevelopment();
runWorkspaceRelease('sync');

const sync = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-mcp-metadata.mjs')], {
  stdio: 'inherit',
});
if (sync.status !== 0) {
  fail('sync-mcp-metadata failed after the version bump.');
}

process.stdout.write(
  `Synchronized development version: ${nextVersion} (public packages + server.json).\n` +
    `Commit and push this so main stays marked as unreleased.\n`,
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runWorkspaceRelease(command) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'release-workspace.mjs'), command],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`Workspace release ${command} failed.`);
}

function markRootAsDevelopment() {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`Unsupported version format: ${version}`);
  const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-dev`;
  const versionField = `"version": "${version}"`;
  if (raw.split(versionField).length !== 2) {
    fail(`Expected exactly one ${versionField} in package.json.`);
  }
  fs.writeFileSync(packagePath, raw.replace(versionField, `"version": "${nextVersion}"`));
  return nextVersion;
}
