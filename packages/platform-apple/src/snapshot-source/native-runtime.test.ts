import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { BUILD_TIMEOUT_MS } from './cache.ts';
import { createSnapshotSourceDeadline, remainingSnapshotSourceMs } from './deadline.ts';

// The host bridge compile is budgeted from a deadline sized to production's build ceiling, not a
// stricter warm-host constant, so a cold runner's first `xcrun` (signature-scan stall plus clang)
// is not tripped before the compile finishes (#2439). The hook budget leaves headroom beyond that.
const COMPILE_HOOK_TIMEOUT_MS = BUILD_TIMEOUT_MS + 30_000;

async function compileSnapshotBridgeFixture(clangArgs: readonly string[]): Promise<void> {
  const deadline = createSnapshotSourceDeadline(BUILD_TIMEOUT_MS, undefined);
  const compiled = await runCmd('xcrun', [...clangArgs], {
    allowFailure: true,
    timeoutMs: remainingSnapshotSourceMs(deadline, 'native-build-deadline'),
  });
  assert.equal(compiled.exitCode, 0, compiled.stderr);
}

describe.skipIf(process.platform !== 'darwin')('native snapshot capture', () => {
  let binary: string;
  beforeAll(async () => {
    binary = path.join(await mkdtempForTest('snapshot-foreground-'), 'foreground-owner');
    const nativeRoot = path.resolve(import.meta.dirname, '../../../../apple/snapshot-bridge');
    await compileSnapshotBridgeFixture([
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
    ]);
  }, COMPILE_HOOK_TIMEOUT_MS);

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

const recoveryFixturePath = path.resolve(
  import.meta.dirname,
  '../../../../contracts/fixtures/ios-ax-recovery-conformance.json',
);
const recoveryFixture = JSON.parse(readFileSync(recoveryFixturePath, 'utf8')) as {
  version: number;
  recoveryCases: readonly { name: string }[];
};

describe.skipIf(process.platform !== 'darwin')(
  'shared AX recovery conformance (host bridge)',
  () => {
    let binary: string;
    beforeAll(async () => {
      binary = path.join(await mkdtempForTest('snapshot-recovery-'), 'recovery-conformance');
      const nativeRoot = path.resolve(import.meta.dirname, '../../../../apple/snapshot-bridge');
      await compileSnapshotBridgeFixture([
        '--sdk',
        'macosx',
        'clang',
        '-fobjc-arc',
        '-framework',
        'Foundation',
        '-I',
        nativeRoot,
        path.join(nativeRoot, 'SnapshotBridgeCapture.m'),
        path.join(import.meta.dirname, 'fixtures/recovery-conformance.m'),
        '-o',
        binary,
      ]);
    }, COMPILE_HOOK_TIMEOUT_MS);

    assert.equal(recoveryFixture.version, 1);
    test.each(recoveryFixture.recoveryCases.map((recoveryCase) => recoveryCase.name))(
      'host bridge recovery matches the shared fixture: %s',
      async (name) => {
        const result = await runCmd(binary, [recoveryFixturePath, name], {
          allowFailure: true,
          timeoutMs: 5_000,
        });
        assert.equal(result.exitCode, 0, result.stderr);
      },
    );
  },
);
