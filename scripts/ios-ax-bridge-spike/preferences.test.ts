import assert from 'node:assert/strict';
import { test } from 'vitest';
import { diffPlistValues, simulatorPreferencePaths } from './preferences.ts';

test('records exact targeted preference changes and ignores unrelated keys', () => {
  assert.deepEqual(
    diffPlistValues(
      { AutomationEnabled: false, Unrelated: 'preserve' },
      { AutomationEnabled: true, Unrelated: 'preserve' },
      ['AutomationEnabled', 'IgnoreAXServerEntitlements'],
    ),
    [
      { key: 'AutomationEnabled', before: false, after: true },
      { key: 'IgnoreAXServerEntitlements' },
    ],
  );
});

test('builds preference paths only from a validated Simulator UDID', () => {
  assert.equal(simulatorPreferencePaths('793B72F6-02C9-4BCD-BEC9-1B3EB42A7ED4').length, 2);
  assert.throws(() => simulatorPreferencePaths('../other-device'), /Invalid Simulator UDID/);
});
