import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { buildPackageXcuitest } from '../build-package-xcuitest.mjs';

type Build = { root: string; platform: string; derivedPath: string };

test('builds every platform into a scratch directory under the repo and removes it', () => {
  const root = mkdtempForTestSync('agent-device-package-xcuitest-');
  const seen: Build[] = [];

  buildPackageXcuitest({
    root,
    build: (build: Build) => {
      seen.push(build);
      fs.mkdirSync(path.join(build.derivedPath, 'Build', 'Products'), { recursive: true });
    },
  });

  assert.deepEqual(
    seen.map(({ platform }) => platform),
    ['ios', 'macos', 'tvos', 'visionos'],
  );
  for (const { derivedPath } of seen) {
    assert.equal(path.dirname(derivedPath), path.join(root, '.tmp', 'package-xcuitest'));
    assert.equal(fs.existsSync(derivedPath), false);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, '.tmp')), []);
});

test('removes the scratch directory when a platform build fails', () => {
  const root = mkdtempForTestSync('agent-device-package-xcuitest-');

  assert.throws(
    () =>
      buildPackageXcuitest({
        root,
        platforms: ['ios', 'macos'],
        build: ({ platform, derivedPath }: Build) => {
          fs.mkdirSync(derivedPath, { recursive: true });
          if (platform === 'macos') throw new Error('xcodebuild failed');
        },
      }),
    /xcodebuild failed/,
  );

  assert.deepEqual(fs.readdirSync(path.join(root, '.tmp')), []);
});

test('starts from an empty scratch directory when an interrupted run left one behind', () => {
  const root = mkdtempForTestSync('agent-device-package-xcuitest-');
  const leftover = path.join(root, '.tmp', 'package-xcuitest', 'ios', 'Build');
  fs.mkdirSync(leftover, { recursive: true });
  let leftoverSeen = true;

  buildPackageXcuitest({
    root,
    platforms: ['ios'],
    build: ({ derivedPath }: Build) => {
      leftoverSeen = fs.existsSync(derivedPath);
    },
  });

  assert.equal(leftoverSeen, false);
});
