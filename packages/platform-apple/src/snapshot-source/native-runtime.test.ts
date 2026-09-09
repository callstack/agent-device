import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';

describe.skipIf(process.platform !== 'darwin')('native snapshot capture', () => {
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
        '-Ddlopen=fixtureDlopen',
        '-Ddlsym=fixtureDlsym',
        '-framework',
        'Foundation',
        '-framework',
        'CoreGraphics',
        '-I',
        nativeRoot,
        path.join(nativeRoot, 'SnapshotBridgeRuntime.m'),
        path.join(nativeRoot, 'SnapshotBridgeCapture.m'),
        path.join(import.meta.dirname, 'fixtures/foreground-owner.m'),
        '-o',
        binary,
      ],
      { allowFailure: true, timeoutMs: 45_000 },
    );
    assert.equal(compiled.exitCode, 0, compiled.stderr);
  }, 60_000);

  test.each([
    'stable',
    'identity',
    'request-budget',
    'runtime-budget',
    'api-depth-0',
    'api-depth-unknown',
    'api-depth-1',
    'api-depth-4',
    'api-depth-128',
    'rejected',
    'wide-nodes',
    'wide-continuation',
    'zero-depth',
    'covered',
    'changed',
    'missing',
    'malformed',
    'depth-recovery',
    'depth-wrapper',
    'depth-missing-element',
    'depth-missing-count',
    'depth-invalid-count',
    'depth-fractional-count',
    'depth-nan-count',
    'depth-negative-count',
    'depth-continuation-count',
    'depth-incomplete',
    'depth-bound',
    'depth-nodes',
    'depth-owner-change',
    'unavailable',
  ])('snapshot capture enforces %s', async (scenario) => {
    const result = await runCmd(binary, [scenario], { allowFailure: true, timeoutMs: 5_000 });
    assert.equal(result.exitCode, 0, result.stderr);
  });
});
