import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
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

// #3260: --text-stdin makes fill block on stdin, so only a typed flag may turn it on.
test('fill --text-stdin has no environment default', () => {
  const parsed = resolveCliOptions(['fill', '@e3', 'typed text'], {
    cwd: process.cwd(),
    env: isolatedEnv({ AGENT_DEVICE_TEXT_STDIN: '1' }),
  });

  assert.equal(parsed.flags.textStdin, undefined);
});

test('a config file cannot set fill --text-stdin', () => {
  const configPath = `${mkdtempForTestSync('agent-device-cli-config-')}/config.json`;
  fs.writeFileSync(configPath, JSON.stringify({ textStdin: true }));

  assert.throws(
    () =>
      resolveCliOptions(['fill', '@e3', 'typed text', '--config', configPath], {
        cwd: process.cwd(),
        env: isolatedEnv({}),
      }),
    /Config key "textStdin" is not allowed/,
  );
});

test('a typed --text-stdin reaches fill', () => {
  const parsed = resolveCliOptions(['fill', '@e3', '--text-stdin'], {
    cwd: process.cwd(),
    env: isolatedEnv({}),
  });

  assert.equal(parsed.flags.textStdin, true);
});

// #4298: device status and device release treat selectors as explicit-only so project config
// (like an iOS udid) never hides claims or overrides an explicit serial/platform.
test('device selectors from a project config never reach device status or device release', () => {
  const projectDir = mkdtempForTestSync('agent-device-project-config-');
  fs.writeFileSync(
    `${projectDir}/agent-device.json`,
    JSON.stringify({
      platform: 'ios',
      udid: '01234567-89AB-CDEF-0123-456789ABCDEF',
      session: 'ios-session',
    }),
  );

  const statusWithoutFlags = resolveCliOptions(['device', 'status'], {
    cwd: projectDir,
    env: isolatedEnv({}),
  });
  assert.equal(statusWithoutFlags.flags.platform, undefined);
  assert.equal(statusWithoutFlags.flags.udid, undefined);

  const statusWithExplicitSerial = resolveCliOptions(
    ['device', 'status', '--platform', 'android', '--serial', 'emulator-5560'],
    {
      cwd: projectDir,
      env: isolatedEnv({}),
    },
  );
  assert.equal(statusWithExplicitSerial.flags.platform, 'android');
  assert.equal(statusWithExplicitSerial.flags.serial, 'emulator-5560');
  assert.equal(statusWithExplicitSerial.flags.udid, undefined);

  const releaseWithExplicitSerial = resolveCliOptions(
    ['device', 'release', '--platform', 'android', '--serial', 'emulator-5560', '--stale'],
    {
      cwd: projectDir,
      env: isolatedEnv({}),
    },
  );
  assert.equal(releaseWithExplicitSerial.flags.platform, 'android');
  assert.equal(releaseWithExplicitSerial.flags.serial, 'emulator-5560');
  assert.equal(releaseWithExplicitSerial.flags.udid, undefined);
  assert.equal(releaseWithExplicitSerial.flags.stale, true);
});

test('typed device selectors still reach device status and device release', () => {
  const parsed = resolveCliOptions(
    ['device', 'status', '--platform', 'ios', '--udid', '01234567-89AB-CDEF-0123-456789ABCDEF'],
    {
      cwd: process.cwd(),
      env: isolatedEnv({}),
    },
  );
  assert.equal(parsed.flags.platform, 'ios');
  assert.equal(parsed.flags.udid, '01234567-89AB-CDEF-0123-456789ABCDEF');
});

// #2161: agent-device.json sets platform/device/udid/serial DEFAULTS, and a default stays
// overridable. `devicePin: true` beside them is the opt-in that turns the configured selector
// into a pin. Option resolution only reads the pin; the client enforces it on the finished request
// (see src/__tests__/cli-device-pin.test.ts).
function projectPinnedTo(config: Record<string, unknown>): string {
  const project = mkdtempForTestSync('agent-device-cli-pin-');
  fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify(config));
  return project;
}

test('without devicePin a configured device stays an overridable default', () => {
  const cwd = projectPinnedTo({ platform: 'ios', device: 'iPad Pro' });
  const parsed = resolveCliOptions(['open', 'com.example.app', '--device', 'iPhone 16'], {
    cwd,
    env: isolatedEnv({}),
  });

  assert.equal(parsed.flags.device, 'iPhone 16');
  assert.equal(parsed.devicePin, undefined);
});

test('a selector-less command inherits the pinned device', () => {
  const cwd = projectPinnedTo({ platform: 'ios', device: 'iPad Pro', devicePin: true });
  const parsed = resolveCliOptions(['open', 'com.example.app'], { cwd, env: isolatedEnv({}) });

  assert.equal(parsed.flags.platform, 'ios');
  assert.equal(parsed.flags.device, 'iPad Pro');
  assert.deepEqual(parsed.devicePin, {
    selector: { platform: 'ios', device: 'iPad Pro' },
    policySource: {
      kind: 'project',
      label: `project config file ${path.join(cwd, 'agent-device.json')}`,
    },
  });
});

test('--device-pin pins the configured defaults for one invocation', () => {
  const cwd = projectPinnedTo({ platform: 'ios', device: 'iPad Pro' });
  const parsed = resolveCliOptions(['open', 'com.example.app', '--device-pin'], {
    cwd,
    env: isolatedEnv({}),
  });

  assert.deepEqual(parsed.devicePin, {
    selector: { platform: 'ios', device: 'iPad Pro' },
    policySource: { kind: 'flag', label: 'the --device-pin flag' },
  });
});
