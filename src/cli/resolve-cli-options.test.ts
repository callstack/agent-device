import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { resolveCliOptions } from './resolve-cli-options.ts';

/**
 * Points `~` at an empty directory so a developer's own ~/.agent-device/config.json cannot add
 * defaults to what a test asserts, and keeps PATH so the rest of resolution behaves.
 */
function isolatedEnv(env: Record<string, string>): Record<string, string> {
  const home = mkdtempForTestSync('agent-device-cli-env-');
  return { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', ...env };
}

test('a frame rate from the environment is not a flag the caller typed', () => {
  // `record stop` reads no recording option. A default it ignores must not become a refusal, or
  // AGENT_DEVICE_FPS in a CI shell would break every `record stop`.
  const parsed = resolveCliOptions(['record', 'stop'], {
    cwd: process.cwd(),
    env: isolatedEnv({ AGENT_DEVICE_FPS: '30' }),
  });

  assert.equal(parsed.flags.fps, 30);
  assert.deepEqual(
    parsed.providedFlags.map((entry) => entry.key),
    [],
  );
});

test('a frame rate the caller typed stays a typed flag', () => {
  const parsed = resolveCliOptions(['record', 'start', './capture.mp4', '--fps', '30'], {
    cwd: process.cwd(),
    env: isolatedEnv({}),
  });

  assert.deepEqual(
    parsed.providedFlags.map((entry) => entry.key),
    ['fps'],
  );
});
