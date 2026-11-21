// The real Node resolver enforces the package exports map that R11 models.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('Node resolution enforces the exports map at runtime', () => {
  const replayPackageRequire = createRequire(path.join(repoRoot, 'packages/replay/package.json'));
  // Real resolver, not the gate's model: a deep import is a resolution error,
  // and the legal subpath realpaths OUTSIDE node_modules (pnpm symlink), which
  // is what lets --experimental-strip-types load package sources in dev.
  const resolved = import.meta.resolve('@agent-device/kernel/errors');
  assert.ok(resolved.endsWith('packages/kernel/src/errors.ts'), resolved);
  for (const deep of [
    '@agent-device/kernel/src/errors.ts',
    '@agent-device/kernel/internal-not-exported',
    '@agent-device/kernel',
    '@agent-device/contracts/not-an-export',
    '@agent-device/contracts/src/gesture-plan-types.ts',
    '@agent-device/contracts',
    '@agent-device/contracts/src/snapshot-text.ts',
    '@agent-device/contracts/src/facades/snapshot.ts',
    '@agent-device/provider-webdriver/runtime',
    '@agent-device/provider-webdriver/src/runtime.ts',
    '@agent-device/limrun/internal',
    '@agent-device/limrun/src/runtime.ts',
    '@agent-device/xml/internal/parser',
    '@agent-device/xml/src/index.ts',
    '@agent-device/ad-script/codec',
    '@agent-device/ad-script/internal/script.ts',
    '@agent-device/ad-script/src/index.ts',
    '@agent-device/ad-replay/testing',
    '@agent-device/ad-replay/internal/target-verification.ts',
    '@agent-device/ad-replay/src/index.ts',
    '@agent-device/replay-test/src/internal/session-test.ts',
    '@agent-device/selectors/internal/parse.ts',
    '@agent-device/selectors/src/index.ts',
  ]) {
    assert.throws(
      () =>
        deep.startsWith('@agent-device/ad-replay/') || deep.startsWith('@agent-device/replay-test/')
          ? replayPackageRequire.resolve(deep)
          : import.meta.resolve(deep),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath|No "exports" main/,
      `${deep} must not resolve`,
    );
  }

  const contractsResolved = import.meta.resolve('@agent-device/contracts/interaction');
  assert.ok(contractsResolved.endsWith('packages/contracts/src/interaction.ts'), contractsResolved);
  const contractsSnapshotResolved = import.meta.resolve('@agent-device/contracts/snapshot');
  assert.ok(
    contractsSnapshotResolved.endsWith('packages/contracts/src/facades/snapshot.ts'),
    contractsSnapshotResolved,
  );
  const contractsReactNativeOverlayResolved = import.meta
    .resolve('@agent-device/contracts/react-native-overlay');
  assert.ok(
    contractsReactNativeOverlayResolved.endsWith('packages/contracts/src/react-native-overlay.ts'),
    contractsReactNativeOverlayResolved,
  );
  assert.throws(() => import.meta.resolve('@agent-device/provider-webdriver'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  const providerWebDriverResolved = import.meta.resolve('@agent-device/provider-webdriver/plugin');
  assert.ok(
    providerWebDriverResolved.endsWith('packages/provider-webdriver/src/plugin.ts'),
    providerWebDriverResolved,
  );
  const providerLimrunResolved = import.meta.resolve('@agent-device/limrun');
  assert.ok(
    providerLimrunResolved.endsWith('packages/provider-limrun/src/index.ts'),
    providerLimrunResolved,
  );
  const xmlResolved = import.meta.resolve('@agent-device/xml');
  assert.ok(xmlResolved.endsWith('packages/xml/src/index.ts'), xmlResolved);
  const adScriptResolved = import.meta.resolve('@agent-device/ad-script');
  assert.ok(adScriptResolved.endsWith('packages/ad-script/src/index.ts'), adScriptResolved);
  const adReplayResolved = replayPackageRequire.resolve('@agent-device/ad-replay');
  const replayTestResolved = replayPackageRequire.resolve('@agent-device/replay-test');
  assert.ok(replayTestResolved.endsWith('packages/replay-test/src/index.ts'), replayTestResolved);
  assert.ok(adReplayResolved.endsWith('packages/ad-replay/src/index.ts'), adReplayResolved);
  const selectorsResolved = import.meta.resolve('@agent-device/selectors');
  assert.ok(selectorsResolved.endsWith('packages/selectors/src/index.ts'), selectorsResolved);
});
