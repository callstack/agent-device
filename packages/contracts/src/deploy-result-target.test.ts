import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveDeployResultTarget,
  resolveInstallFromSourceResultTarget,
} from './deploy-result-target.ts';

test('resolveDeployResultTarget follows the public app target precedence', () => {
  assert.equal(
    resolveDeployResultTarget({ app: 'fallback', bundleId: 'com.example.app', package: 'example' }),
    'com.example.app',
  );
  assert.equal(resolveDeployResultTarget({ app: 'fallback', package: 'example' }), 'example');
  assert.equal(resolveDeployResultTarget({ app: 'fallback' }), 'fallback');
});

test('resolveInstallFromSourceResultTarget follows the public install target precedence', () => {
  assert.equal(
    resolveInstallFromSourceResultTarget({
      launchTarget: 'com.example.app',
      appName: 'Demo',
      bundleId: 'com.example.bundle',
      packageName: 'com.example.package',
    }),
    'Demo',
  );
  assert.equal(
    resolveInstallFromSourceResultTarget({
      launchTarget: 'com.example.app',
      packageName: 'com.example.package',
    }),
    'com.example.package',
  );
});
