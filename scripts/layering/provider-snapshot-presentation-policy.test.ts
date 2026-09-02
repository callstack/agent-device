import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  IOS_SNAPSHOT_PRESENTATION_OWNER,
  LIMRUN_IOS_SNAPSHOT_ADAPTER,
  PROVIDER_SNAPSHOT_PRESENTATION_RULE,
  SNAPSHOT_RUNTIME_HOST,
  WEBDRIVER_IOS_SNAPSHOT_ADAPTER,
  providerSnapshotPresentationViolations,
} from './provider-snapshot-presentation-policy.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function currentSources(): Map<string, string> {
  return new Map(
    [
      WEBDRIVER_IOS_SNAPSHOT_ADAPTER,
      LIMRUN_IOS_SNAPSHOT_ADAPTER,
      IOS_SNAPSHOT_PRESENTATION_OWNER,
      SNAPSHOT_RUNTIME_HOST,
      'packages/provider-webdriver/src/platform-runtime.ts',
      'packages/provider-limrun/src/app-log-runtime.ts',
    ].map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
}

test('provider adapters carry facts while one host module owns presentation', () => {
  assert.deepEqual(providerSnapshotPresentationViolations(currentSources()), []);
});

test('the structural gate rejects a planted provider presentation path', () => {
  const sources = currentSources();
  sources.set(
    WEBDRIVER_IOS_SNAPSHOT_ADAPTER,
    `${sources.get(WEBDRIVER_IOS_SNAPSHOT_ADAPTER)}\nconst duplicatePresentation = presentIosSnapshot;\n`,
  );

  const violations = providerSnapshotPresentationViolations(sources);
  assert.ok(
    violations.some(
      (entry) =>
        entry.rule === PROVIDER_SNAPSHOT_PRESENTATION_RULE &&
        entry.message.includes('presentIosSnapshot'),
    ),
    JSON.stringify(violations),
  );
});
