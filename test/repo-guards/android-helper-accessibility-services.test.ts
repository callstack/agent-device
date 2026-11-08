import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const instrumentationPath = path.join(
  repoRoot,
  'android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/SnapshotInstrumentation.java',
);

test('the Android helper connection preserves accessibility services on API 24+', () => {
  const source = fs
    .readFileSync(instrumentationPath, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const connection = source.match(
    /private UiAutomation tryGetConnectedUiAutomation\(\) \{([\s\S]*?)\n {2}\}/,
  )?.[1];
  assert.ok(connection, 'the shared UiAutomation connection method must exist');
  assert.match(
    connection,
    /^\s*UiAutomation automation;\s*if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.N\) \{\s*automation = getUiAutomation\(UiAutomation\.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES\);\s*\} else \{\s*automation = getUiAutomation\(\);\s*\}/,
  );
  assert.equal(connection.match(/\bgetUiAutomation\(/g)?.length, 2);
});
