import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helperSourceDir = path.join(repoRoot, 'android/snapshot-helper/src/main/java');
const dispatcherFile = path.join(
  'com/callstack/agentdevice/snapshothelper',
  'UiAutomationInputDispatcher.java',
);

// The public two-argument UiAutomation overload waits up to five seconds for global window
// animations before a gesture's first event and after its last one (#4590, #1356).
test('Android helper input reaches the framework only through the dispatcher without the animation wait', () => {
  const sources = fs
    .readdirSync(helperSourceDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.java'));
  assert.ok(sources.includes(dispatcherFile), 'the input dispatcher must exist');
  const directInjectors = sources.filter(
    (name) =>
      name !== dispatcherFile &&
      /\.injectInputEvent\(/.test(
        fs
          .readFileSync(path.join(helperSourceDir, name), 'utf8')
          .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''),
      ),
  );
  assert.deepEqual(directInjectors, []);
  assert.match(
    fs.readFileSync(path.join(helperSourceDir, dispatcherFile), 'utf8'),
    /method\.invoke\(automation, event, waitForDispatch, false\)/,
  );
});
