import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { pluginHome } from '@agent-device/test-kit';
import {
  assertSelectorHonorsDevicePin,
  DEVICE_PIN_CONFLICT_REASON,
  DEVICE_PIN_WITHOUT_SELECTOR_REASON,
  resolveConfigBackedFlagDefaultsWithProvenance,
  resolveDevicePin,
  resolveSelectorOrigins,
} from './cli-config.ts';

const cliFlags = { help: false, version: false, json: false };

function failsWithReason(reason: string, message?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error && 'code' in error && 'details' in error);
    assert.equal(error.code, 'INVALID_ARGS');
    assert.equal((error.details as { reason?: string }).reason, reason);
    if (message) assert.match(error.message, message);
    return true;
  };
}

function projectWithConfig(config: Record<string, unknown>) {
  const { home, env } = pluginHome();
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify(config));
  return { home, project, env };
}

test('the merge records which layer set each default', () => {
  const { home, project, env } = projectWithConfig({ device: 'iPad Pro', devicePin: true });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ platform: 'android', device: 'Pixel 8' }),
  );
  const resolved = resolveConfigBackedFlagDefaultsWithProvenance({
    command: 'open',
    cwd: project,
    cliFlags,
    env: { ...env, AGENT_DEVICE_PLATFORM: 'ios' },
  });

  assert.deepEqual(resolved.flags, { platform: 'ios', device: 'iPad Pro', devicePin: true });
  assert.equal(resolved.provenance.platform?.kind, 'env');
  assert.equal(resolved.provenance.platform?.label, 'environment variable AGENT_DEVICE_PLATFORM');
  assert.equal(resolved.provenance.device?.kind, 'project');
  assert.equal(
    resolved.provenance.device?.label,
    `project config file ${path.join(project, 'agent-device.json')}`,
  );
  assert.equal(resolved.provenance.devicePin?.kind, 'project');
});

test('configured selectors stay overridable defaults until devicePin opts in', () => {
  const { project, env } = projectWithConfig({ platform: 'ios', device: 'iPad Pro' });
  const resolved = resolveConfigBackedFlagDefaultsWithProvenance({
    command: 'open',
    cwd: project,
    cliFlags,
    env,
  });

  assert.equal(resolveDevicePin(resolved.flags, resolved.provenance), undefined);
  assert.deepEqual(
    resolveSelectorOrigins({ device: 'iPhone 16' }, new Set(['device']), undefined),
    {
      device: 'flag',
    },
  );
  assert.deepEqual(resolveSelectorOrigins(resolved.flags, new Set(), undefined), {
    platform: 'default',
    device: 'default',
  });
});

test('devicePin pins every configured selector and names the layer that set it', () => {
  const { project, env } = projectWithConfig({
    platform: 'ios',
    device: 'iPad Pro',
    devicePin: true,
  });
  const resolved = resolveConfigBackedFlagDefaultsWithProvenance({
    command: 'open',
    cwd: project,
    cliFlags,
    env,
  });
  const pin = resolveDevicePin(resolved.flags, resolved.provenance);

  assert.ok(pin);
  assert.deepEqual(pin.selector, { platform: 'ios', device: 'iPad Pro' });
  assert.equal(pin.policySource.kind, 'project');
  assert.equal(pin.sources.device?.kind, 'project');
  assert.deepEqual(resolveSelectorOrigins(resolved.flags, new Set(), pin), {
    platform: 'pin',
    device: 'pin',
  });
});

test('a pin with nothing to pin fails before any daemon is contacted', () => {
  const { project, env } = projectWithConfig({ devicePin: true });
  const resolved = resolveConfigBackedFlagDefaultsWithProvenance({
    command: 'open',
    cwd: project,
    cliFlags,
    env,
  });

  assert.throws(
    () => resolveDevicePin(resolved.flags, resolved.provenance),
    failsWithReason(DEVICE_PIN_WITHOUT_SELECTOR_REASON, /no platform, device, udid, or serial/),
  );
});

test('AGENT_DEVICE_DEVICE_PIN turns the pin on for an operator shell', () => {
  const { project, env } = projectWithConfig({ platform: 'android', serial: 'emulator-5554' });
  const resolved = resolveConfigBackedFlagDefaultsWithProvenance({
    command: 'open',
    cwd: project,
    cliFlags,
    env: { ...env, AGENT_DEVICE_DEVICE_PIN: 'true' },
  });
  const pin = resolveDevicePin(resolved.flags, resolved.provenance);

  assert.ok(pin);
  assert.deepEqual(pin.selector, { platform: 'android', serial: 'emulator-5554' });
  assert.equal(pin.policySource.label, 'environment variable AGENT_DEVICE_DEVICE_PIN');
});

const pin = {
  selector: { platform: 'ios' as const, device: 'iPad Pro' },
  sources: {},
  policySource: { kind: 'project' as const, label: 'project config file /repo/agent-device.json' },
};

test('an explicit selector that contradicts the pin fails with a typed reason naming the source', () => {
  assert.throws(
    () => assertSelectorHonorsDevicePin(pin, { device: 'iPhone 16' }, 'cli'),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'details' in error);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /^--device "iPhone 16" conflicts with the device pin/);
      assert.match(error.message, /project config file \/repo\/agent-device\.json/);
      assert.match(error.message, /pins platform "ios", device "iPad Pro"/);
      assert.match(error.message, /remove "devicePin"/);
      assert.deepEqual(error.details, {
        reason: DEVICE_PIN_CONFLICT_REASON,
        pin: { platform: 'ios', device: 'iPad Pro' },
        pinSource: 'project config file /repo/agent-device.json',
        conflicts: [{ key: 'device', pinned: 'iPad Pro', requested: 'iPhone 16' }],
        hint: (error.details as { hint: string }).hint,
      });
      return true;
    },
  );
});

test('tool input names the bare key instead of a CLI token', () => {
  assert.throws(
    () => assertSelectorHonorsDevicePin(pin, { platform: 'android' }, 'input'),
    failsWithReason(
      DEVICE_PIN_CONFLICT_REASON,
      /^platform "android" conflicts with the device pin/,
    ),
  );
});

test('a selector that repeats or refines the pin passes', () => {
  assertSelectorHonorsDevicePin(pin, {}, 'cli');
  assertSelectorHonorsDevicePin(pin, { platform: 'ios', device: 'iPad Pro' }, 'cli');
  // A UDID picks one device among several that share the pinned name; selection has to satisfy both.
  assertSelectorHonorsDevicePin(pin, { udid: 'ABCDEF' }, 'cli');
});
