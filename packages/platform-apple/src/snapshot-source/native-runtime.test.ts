import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';

describe.skipIf(process.platform !== 'darwin')('native snapshot foreground ownership', () => {
  let binary: string;
  beforeAll(async () => {
    binary = path.join(await mkdtempForTest('snapshot-foreground-'), 'foreground-owner');
    const nativeRoot = path.resolve(import.meta.dirname, '../../../../apple/snapshot-bridge');
    const compiled = await runCmd(
      'xcrun',
      [
        '--sdk',
        'macosx',
        'clang',
        '-fobjc-arc',
        '-framework',
        'Foundation',
        '-framework',
        'CoreGraphics',
        '-I',
        nativeRoot,
        path.join(nativeRoot, 'SnapshotBridgeRuntime.m'),
        path.join(import.meta.dirname, 'fixtures/foreground-owner.m'),
        '-o',
        binary,
      ],
      { allowFailure: true, timeoutMs: 45_000 },
    );
    assert.equal(compiled.exitCode, 0, compiled.stderr);
  }, 60_000);

  test('admits only the current primary target and refuses covered or unknown ownership', async () => {
    const result = await runCmd(binary, [], { allowFailure: true });
    assert.equal(result.exitCode, 0, result.stderr);
  });
});
