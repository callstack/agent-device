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

// #3179: settings consumes --app only when this invocation typed it. A mutation that silently
// landed on AGENT_DEVICE_TARGET_APP would change permissions for an app the caller never named,
// while `doctor --app` (and its env default) still reads a configured default app by design.
test('an app from the environment never reaches a settings mutation', () => {
  const parsed = resolveCliOptions(['settings', 'permission', 'grant', 'camera'], {
    cwd: process.cwd(),
    env: isolatedEnv({ AGENT_DEVICE_TARGET_APP: 'com.example.configured' }),
  });

  assert.equal(parsed.flags.targetApp, undefined);
  assert.deepEqual(
    parsed.providedFlags.map((entry) => entry.key),
    [],
  );
});

test('a typed --app still reaches a settings mutation', () => {
  const parsed = resolveCliOptions(
    ['settings', 'permission', 'grant', 'camera', '--app', 'com.example.typed'],
    {
      cwd: process.cwd(),
      env: isolatedEnv({ AGENT_DEVICE_TARGET_APP: 'com.example.configured' }),
    },
  );

  assert.equal(parsed.flags.targetApp, 'com.example.typed');
});

test('the same env default keeps filling doctor, which reads a configured app without a mutation', () => {
  const parsed = resolveCliOptions(['doctor'], {
    cwd: process.cwd(),
    env: isolatedEnv({ AGENT_DEVICE_TARGET_APP: 'com.example.configured' }),
  });

  assert.equal(parsed.flags.targetApp, 'com.example.configured');
});
