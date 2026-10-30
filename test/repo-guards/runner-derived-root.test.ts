import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import {
  resolveRunnerKeyedDerivedPath,
  type RunnerXctestrunCacheMetadata,
} from '../../packages/apple-runner/src/runner-cache-metadata.ts';
import { resolveRunnerScriptDefaultDerivedPath } from '../../packages/platform-apple/src/core/runner-script.ts';

test('the script derived root contains the runner keyed cache', () => {
  const cache = resolveRunnerKeyedDerivedPath(IOS_SIMULATOR, {} as RunnerXctestrunCacheMetadata);
  assert.equal(
    path.dirname(path.dirname(cache)),
    resolveRunnerScriptDefaultDerivedPath('ios', os.homedir()),
  );
});
