#!/usr/bin/env node
// Installs the cached Android Release fixture (examples/test-app) onto one emulator, so the perf
// suite and the Android benchmarks drive the app their steps expect.
//
//   pnpm test-app:android:fixture --serial <serial>
//
// It resolves the current Expo fingerprint's artifact name, downloads that trusted artifact into a
// fresh directory, repacks it with the current JavaScript, installs it, and re-runs the fixture
// preflight. It automates the recipe documented in scripts/perf/README.md and reuses the
// .github/actions/setup-fixture-app owners for the name, the trust rules, and the repack.
//
// A downloaded archive is untrusted data: it is unpacked only into fresh empty directories, and
// nothing from it is executed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FIXTURE_APP_ID, assertAndroidReleaseFixture } from './perf/fixture-preflight.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTION_PATH = path.join(REPO_ROOT, '.github', 'actions', 'setup-fixture-app');
const BUILD_CACHE_WORKFLOW = '.github/workflows/test-app-build-cache.yml';
const ARCHIVE_MEMBER = 'binary.tar.gz';

function run(command, args, options = {}) {
  const { capture = false, ...rest } = options;
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
    ...rest,
  });
}

function parseSerial(argv) {
  const index = argv.indexOf('--serial');
  if (index === -1) throw new Error('usage: pnpm test-app:android:fixture --serial <serial>');
  const serial = argv[index + 1];
  if (!serial || serial.startsWith('--'))
    throw new Error('usage: pnpm test-app:android:fixture --serial <serial>');
  return serial;
}

/** Accepts the scp-like, https and ssh GitHub URL shapes a `origin` remote takes. */
function parseRepository(slug) {
  const target = slug
    .trim()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^[^/@]+@/, '');
  const match = /^github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(target);
  if (!match) throw new Error(`unsupported GitHub remote: ${slug.trim()}`);
  return `${match[1]}/${match[2]}`;
}

function resolveAdb() {
  const sdkRoot = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  if (!sdkRoot)
    throw new Error(
      'Set ANDROID_HOME to the Android SDK root (it provides adb and the repack build-tools).',
    );
  const adb = path.join(sdkRoot, 'platform-tools', 'adb');
  if (!fs.existsSync(adb)) throw new Error(`adb was not found at ${adb}.`);
  return adb;
}

/** The trusted artifact id for one name: this head first, then a main-branch build of the same key. */
function findTrustedArtifactId({ repository, name, headShas, token }) {
  for (const headSha of headShas) {
    const id = run(
      process.execPath,
      [path.join(ACTION_PATH, 'trusted-artifact.mjs'), 'find', repository, name, headSha],
      { capture: true, env: { ...process.env, GH_TOKEN: token } },
    ).trim();
    if (id) return id;
  }
  return undefined;
}

/** The one `.apk` at the top of an unpacked artifact; the same contract as locate-android-apk.sh. */
function findUnpackedApk(dir) {
  const apks = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.apk'))
    .map((entry) => path.join(dir, entry.name));
  if (apks.length !== 1)
    throw new Error(
      `Expected exactly one fixture APK in ${dir}; found ${apks.length}. The artifact layout changed.`,
    );
  return path.resolve(apks[0]);
}

function freshDir(name) {
  const root = path.join(REPO_ROOT, '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  return dir;
}

function main() {
  const serial = parseSerial(process.argv.slice(2));
  const adb = resolveAdb();
  if (!fs.existsSync(path.join(REPO_ROOT, 'examples', 'test-app', 'node_modules')))
    throw new Error(
      'Run `pnpm test-app:install` first (the fingerprint and repack tools live there).',
    );

  const name = run('sh', [path.join(ACTION_PATH, 'resolve-artifact-name.sh'), 'android'], {
    capture: true,
  }).trim();

  const repository = parseRepository(
    run('git', ['remote', 'get-url', 'origin'], { capture: true }),
  );
  const headShas = [run('git', ['rev-parse', 'HEAD'], { capture: true }).trim()];
  // A clone without a fetched origin/main still resolves an artifact for the current head.
  try {
    headShas.push(run('git', ['rev-parse', 'origin/main'], { capture: true }).trim());
  } catch {}
  const token = run('gh', ['auth', 'token'], { capture: true }).trim();
  const artifactId = findTrustedArtifactId({ repository, name, headShas, token });
  if (!artifactId) {
    throw new Error(
      `No trusted ${name} artifact exists for ${repository} at this head or on main. ` +
        `The producer that publishes it is ${BUILD_CACHE_WORKFLOW}; push the current native ` +
        `fingerprint there, or build the APK the same way that workflow does.`,
    );
  }

  const downloadDir = freshDir('fixture-android-download');
  const stageDir = freshDir('fixture-android-stage');
  const repackDir = freshDir('fixture-android-repacked');
  try {
    // stageDir holds the raw archive members; downloadDir holds the unpacked fixture.
    // gh writes the zip to stdout, so it goes straight to a file handle.
    const zipHandle = fs.openSync(path.join(stageDir, 'artifact.zip'), 'w');
    try {
      run('gh', ['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`], {
        stdio: ['ignore', zipHandle, 'inherit'],
      });
    } finally {
      fs.closeSync(zipHandle);
    }
    run('unzip', ['-q', path.join(stageDir, 'artifact.zip'), '-d', stageDir]);
    run('tar', ['-xzf', path.join(stageDir, ARCHIVE_MEMBER), '-C', downloadDir]);
    const sourceApk = findUnpackedApk(downloadDir);

    const outApk = path.join(repackDir, 'fixture-app.apk');
    // The repack swaps the current JavaScript into the cached native build, and re-signs and
    // verifies the result, including that the package id and certificate are preserved.
    run('bash', [path.join(ACTION_PATH, 'repack-android-apk.sh'), sourceApk, outApk]);
    run(adb, ['-s', serial, 'install', '-r', outApk]);
    assertAndroidReleaseFixture({ serial, appId: DEFAULT_FIXTURE_APP_ID, adb });
    process.stdout.write(`Release fixture ${name} installed on ${serial}\n`);
  } finally {
    for (const dir of [downloadDir, stageDir, repackDir])
      fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
