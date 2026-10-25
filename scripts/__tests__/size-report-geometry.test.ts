import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';
import { assertPackagedRunnerSharedHeaderMirror } from '../size-report-geometry.mjs';

const RUNNER_BRIDGE_SOURCE =
  'dist/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerXCTestEventBridge.m';

test('the packaged runner include drives the shared-header mirror requirement', async () => {
  const root = await mkdtempForTest('agent-device-packaged-geometry-');
  const sourceFile = join(root, RUNNER_BRIDGE_SOURCE);
  try {
    await mkdir(join(sourceFile, '..'), { recursive: true });
    await writeFile(sourceFile, '// predates the shared header\n');
    // A runner that never includes the shared header needs no mirror, in either mode.
    assert.doesNotThrow(() => assertPackagedRunnerSharedHeaderMirror(root, []));
    assert.doesNotThrow(() => assertPackagedRunnerSharedHeaderMirror(root));

    await writeFile(
      sourceFile,
      '#import "../../../snapshot-bridge/ForegroundApplicationGeometry.h"\n',
    );
    // Entries mode: the file may exist in the working tree yet miss the pack through the npm
    // `files` allowlist, so the pack's own entry list decides.
    assert.throws(
      () => assertPackagedRunnerSharedHeaderMirror(root, [RUNNER_BRIDGE_SOURCE]),
      /dist\/apple\/snapshot-bridge\/ForegroundApplicationGeometry\.h/,
    );
    assert.doesNotThrow(() =>
      assertPackagedRunnerSharedHeaderMirror(root, [
        RUNNER_BRIDGE_SOURCE,
        'dist/apple/snapshot-bridge/ForegroundApplicationGeometry.h',
      ]),
    );

    // Filesystem mode: the clean-installed tree carries the mirror file itself.
    assert.throws(
      () => assertPackagedRunnerSharedHeaderMirror(root),
      /ForegroundApplicationGeometry/,
    );
    await mkdir(join(root, 'dist', 'apple', 'snapshot-bridge'), { recursive: true });
    await writeFile(join(root, 'dist/apple/snapshot-bridge/ForegroundApplicationGeometry.h'), '');
    assert.doesNotThrow(() => assertPackagedRunnerSharedHeaderMirror(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
