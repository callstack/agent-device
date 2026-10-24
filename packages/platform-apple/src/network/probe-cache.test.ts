import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeAll, describe, test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import {
  buildNetworkCaptureProbeCompileArgv,
  NETWORK_PROBE_BUILD_TIMEOUT_MS,
} from './probe-cache.ts';

test('the runtime probe build never uses -Werror', () => {
  assert.ok(
    !buildNetworkCaptureProbeCompileArgv({ sourceRoot: '', outputPath: '' }).includes('-Werror'),
  );
});

test('the probe build targets the simulator SDK for both simulator architectures', () => {
  const argv = buildNetworkCaptureProbeCompileArgv({
    sourceRoot: '/src',
    outputPath: '/out/ADNetworkCapture.dylib',
  });
  assert.ok(argv.includes('--sdk'));
  assert.ok(argv.includes('iphonesimulator'));
  assert.ok(argv.includes('-arch'));
  assert.ok(argv.includes('arm64'));
  assert.ok(argv.includes('x86_64'));
  assert.ok(argv.includes('-dynamiclib'));
  assert.equal(argv.at(-3), path.join('/src', 'ADNetworkCapture.m'));
  assert.equal(argv.at(-2), '-o');
  assert.equal(argv.at(-1), '/out/ADNetworkCapture.dylib');
});

// Mirrors the fold helper's posture: the production compile drops -Werror so a stale toolchain
// warning cannot fail a launch, and this gate compiles the shipped probe source with -Werror
// appended against the real iphonesimulator SDK, so a new probe warning fails here instead of
// nowhere. The compile runs in beforeAll so its wall time stays out of the test case (see the
// unit slow-test budget in docs/agents/testing.md).
describe.skipIf(process.platform !== 'darwin')('network capture probe warning gate', () => {
  let compiled: { exitCode: number; stderr: string };
  beforeAll(async () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../../../../apple/network-capture');
    const binary = path.join(
      await mkdtempForTest('network-capture-werror-'),
      'ADNetworkCapture.dylib',
    );
    const argv = buildNetworkCaptureProbeCompileArgv({ sourceRoot, outputPath: binary });
    compiled = await runCmd('xcrun', [...argv, '-Werror'], {
      allowFailure: true,
      timeoutMs: NETWORK_PROBE_BUILD_TIMEOUT_MS,
    });
  }, NETWORK_PROBE_BUILD_TIMEOUT_MS + 30_000);

  test('the production probe argv compiles clean under -Werror', () => {
    assert.equal(compiled.exitCode, 0, compiled.stderr);
  });
});
