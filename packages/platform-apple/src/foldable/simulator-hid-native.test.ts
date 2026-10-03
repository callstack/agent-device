import path from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';

describe.skipIf(process.platform !== 'darwin')('native keyframes', () => {
  let binary: string;
  beforeAll(async () => {
    const root = findProjectRoot();
    const directory = await mkdtempForTest('fold-native-');
    binary = path.join(directory, 'keyframes');
    const build = await runCmd(
      'xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-framework',
        'Foundation',
        '-framework',
        'IOKit',
        '-I',
        path.join(root, 'apple/fold-helper'),
        path.join(import.meta.dirname, 'fixtures/keyframes.m'),
        '-o',
        binary,
      ],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    expect(build.exitCode, build.stderr).toBe(0);
  }, 40_000);
  test('validation agrees with the shared golden table', async () => {
    const checked = await runCmd(
      binary,
      [path.join(findProjectRoot(), 'contracts/fixtures/fold-keyframes.json')],
      { allowFailure: true, timeoutMs: 5_000 },
    );
    expect(checked.exitCode, checked.stderr).toBe(0);
  });
});
