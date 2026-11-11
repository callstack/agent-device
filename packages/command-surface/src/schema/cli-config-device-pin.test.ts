import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { pluginHome } from '@agent-device/test-kit';
import { resolveConfigDefaults } from './cli-config.ts';

function projectWithConfig(config: Record<string, unknown>) {
  const { home, env } = pluginHome();
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const configPath = path.join(project, 'agent-device.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const options = {
    command: 'open',
    cwd: project,
    env,
    cliFlags: { help: false, version: false, json: false },
  };
  return { home, configPath, options };
}

test('a pin keeps its own selectors and source independent of ordinary defaults', () => {
  const { configPath, options } = projectWithConfig({
    platform: 'android',
    device: 'Pixel 8',
    devicePin: { platform: 'ios', device: 'iPad Pro' },
  });
  const resolved = resolveConfigDefaults({
    ...options,
    env: { ...options.env, AGENT_DEVICE_PLATFORM: 'android' },
  });
  assert.deepEqual(resolved.flags, { platform: 'ios', device: 'iPad Pro' });
  assert.deepEqual(resolved.devicePin, {
    selector: { platform: 'ios', device: 'iPad Pro' },
    source: { kind: 'project', path: configPath },
  });
});

test('a project pin replaces the entire user pin, including its source', () => {
  const { home, configPath, options } = projectWithConfig({ devicePin: { device: 'iPad Pro' } });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      devicePin: { platform: 'android', serial: 'emulator-5554' },
    }),
  );
  const resolved = resolveConfigDefaults(options);
  assert.deepEqual(resolved.flags, { device: 'iPad Pro' });
  assert.deepEqual(resolved.devicePin, {
    selector: { device: 'iPad Pro' },
    source: { kind: 'project', path: configPath },
  });
});

test('user pins are inherited; an explicit config replaces both implicit config files', () => {
  const { home, options } = projectWithConfig({ session: 'workspace' });
  const userPath = path.join(home, 'config.json');
  fs.writeFileSync(userPath, JSON.stringify({ devicePin: { serial: 'emulator-5554' } }));
  assert.deepEqual(resolveConfigDefaults(options).devicePin, {
    selector: { serial: 'emulator-5554' },
    source: { kind: 'user', path: userPath },
  });
  const explicitPath = path.join(home, 'explicit.json');
  fs.writeFileSync(explicitPath, JSON.stringify({ devicePin: { udid: 'IPAD-001' } }));
  const resolved = resolveConfigDefaults({
    ...options,
    env: { ...options.env, AGENT_DEVICE_CONFIG: explicitPath },
  });
  assert.deepEqual(resolved.flags, { udid: 'IPAD-001' });
  assert.deepEqual(resolved.devicePin, {
    selector: { udid: 'IPAD-001' },
    source: { kind: 'explicit', path: explicitPath },
  });
});

test('without a pin the config and environment retain ordinary default precedence', () => {
  const { options } = projectWithConfig({ platform: 'ios', device: 'iPad Pro' });
  const resolved = resolveConfigDefaults({
    ...options,
    env: { ...options.env, AGENT_DEVICE_PLATFORM: 'android' },
  });
  assert.equal(resolved.flags.platform, 'android');
  assert.equal(resolved.devicePin, undefined);
});

for (const value of [
  true,
  false,
  null,
  {},
  [],
  { device: '' },
  { device: 4 },
  { target: 'mobile' },
  { platform: 'windows' },
  { platform: 'ios', serial: 'emulator-5554' },
  { platform: 'android', udid: 'IPAD-001' },
  { udid: 'IPAD-001', serial: 'emulator-5554' },
]) {
  test(`invalid pin ${JSON.stringify(value)} fails with its config source`, () => {
    const { configPath, options } = projectWithConfig({ devicePin: value });
    assert.throws(
      () => resolveConfigDefaults(options),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error && 'details' in error);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.deepEqual(error.details, {
          reason: 'invalid_device_pin',
          pinSource: `project config file ${configPath}`,
        });
        return true;
      },
    );
  });
}
