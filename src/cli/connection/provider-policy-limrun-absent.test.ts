import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runCliCapture } from '../../__tests__/cli-capture.ts';

test('connect limrun without the plugin answers plugin-not-installed with the install command', async () => {
  const result = await runCliCapture(
    ['connect', 'limrun', '--session', 'ci', '--platform', 'android', '--json'],
    {
      env: { LIMRUN_API_KEY: 'lim_test_key' },
      stateDirPrefix: 'agent-device-connect-limrun-absent-',
    },
  );

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  const { error } = JSON.parse(result.stdout);
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(error.message, 'Limrun requires the @agent-device/limrun plugin.');
  assert.equal(error.details.reason, 'plugin-not-installed');
  assert.equal(error.details.provider, 'limrun');
  assert.equal(error.details.package, '@agent-device/limrun');
  assert.match(error.hint, /agent-device plugins add @agent-device\/limrun/);
});
