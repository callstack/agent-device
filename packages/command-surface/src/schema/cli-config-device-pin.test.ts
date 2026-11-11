import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { pluginHome } from '@agent-device/test-kit';
import {
  assertRequestHonorsDevicePin,
  DEVICE_PIN_CONFLICT_REASON,
  DEVICE_PIN_WITHOUT_SELECTOR_REASON,
  resolveConfigBackedFlagDefaultsWithProvenance,
  resolveDevicePin,
  type DevicePin,
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

function resolvedDefaults(project: string, env: Record<string, string>) {
  return resolveConfigBackedFlagDefaultsWithProvenance({
    command: 'open',
    cwd: project,
    cliFlags,
    env,
  });
}

test('configured selectors stay overridable defaults until devicePin opts in', () => {
  const { project, env } = projectWithConfig({ platform: 'ios', device: 'iPad Pro' });

  assert.equal(resolveDevicePin(resolvedDefaults(project, env)), undefined);
});

test('devicePin pins every configured selector and names the layer that turned it on', () => {
  const { project, env } = projectWithConfig({
    platform: 'ios',
    device: 'iPad Pro',
    udid: '00008110-000A1B2C3D4E5F60',
    serial: 'R5CT1234ABC',
    devicePin: true,
  });
  const defaults = resolvedDefaults(project, env);

  for (const key of ['platform', 'device', 'udid', 'serial'] as const) {
    assert.equal(defaults.provenance[key]?.kind, 'project', key);
  }
  assert.deepEqual(resolveDevicePin(defaults), {
    selector: {
      platform: 'ios',
      device: 'iPad Pro',
      udid: '00008110-000A1B2C3D4E5F60',
      serial: 'R5CT1234ABC',
    },
    policySource: {
      kind: 'project',
      label: `project config file ${path.join(project, 'agent-device.json')}`,
    },
  });
});

test('an explicit --device-pin turns the configured defaults into a pin', () => {
  const { project, env } = projectWithConfig({ platform: 'android', serial: 'emulator-5554' });

  assert.deepEqual(resolveDevicePin(resolvedDefaults(project, env), true), {
    selector: { platform: 'android', serial: 'emulator-5554' },
    policySource: { kind: 'flag', label: 'the --device-pin flag' },
  });
});

test('a pin with nothing to pin fails before any daemon is contacted', () => {
  const { project, env } = projectWithConfig({ devicePin: true });

  assert.throws(
    () => resolveDevicePin(resolvedDefaults(project, env)),
    failsWithReason(DEVICE_PIN_WITHOUT_SELECTOR_REASON, /no platform, device, udid, or serial/),
  );
});

test('AGENT_DEVICE_DEVICE_PIN turns the pin on for an operator shell', () => {
  const { project, env } = projectWithConfig({ platform: 'android', serial: 'emulator-5554' });
  const pin = resolveDevicePin(
    resolvedDefaults(project, { ...env, AGENT_DEVICE_DEVICE_PIN: 'true' }),
  );

  assert.deepEqual(pin, {
    selector: { platform: 'android', serial: 'emulator-5554' },
    policySource: {
      kind: 'env',
      label: 'environment variable AGENT_DEVICE_DEVICE_PIN',
      envName: 'AGENT_DEVICE_DEVICE_PIN',
    },
  });
});

test('--device-pin over a config that also pins keeps that layer for the remedy', () => {
  const { project, env } = projectWithConfig({
    platform: 'ios',
    device: 'iPad Pro',
    devicePin: true,
  });
  const flagPin = resolveDevicePin(resolvedDefaults(project, env), true);

  assert.deepEqual(flagPin, {
    selector: { platform: 'ios', device: 'iPad Pro' },
    policySource: { kind: 'flag', label: 'the --device-pin flag' },
    underlyingPolicySource: {
      kind: 'project',
      label: `project config file ${path.join(project, 'agent-device.json')}`,
    },
  });
  assert.throws(
    () => assertRequestHonorsDevicePin(flagPin!, { flags: { device: 'iPhone 16' } }),
    (error: unknown) => {
      assert.ok(failsWithReason(DEVICE_PIN_CONFLICT_REASON)(error));
      assert.ok(
        (error as Error).message.endsWith(
          `. Drop --device-pin and set "devicePin": false in project config file ${path.join(project, 'agent-device.json')} to target another device.`,
        ),
        (error as Error).message,
      );
      return true;
    },
  );
});

test('AGENT_DEVICE_DEVICE_PIN=0 turns off a pin a config file sets', () => {
  const { project, env } = projectWithConfig({
    platform: 'ios',
    device: 'iPad Pro',
    devicePin: true,
  });

  assert.equal(
    resolveDevicePin(resolvedDefaults(project, { ...env, AGENT_DEVICE_DEVICE_PIN: '0' })),
    undefined,
  );
});

const pin: DevicePin = {
  selector: { platform: 'ios', device: 'iPad Pro' },
  policySource: { kind: 'project', label: 'project config file /repo/agent-device.json' },
};

test('a request selector that contradicts the pin fails with a typed reason naming the source', () => {
  assert.throws(
    () => assertRequestHonorsDevicePin(pin, { flags: { device: 'iPhone 16' } }),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'details' in error);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(
        error.message,
        'device "iPhone 16" conflicts with the device pin from project config file /repo/agent-device.json, which pins platform "ios", device "iPad Pro". Set "devicePin": false in that config to target another device.',
      );
      assert.deepEqual(error.details, {
        reason: DEVICE_PIN_CONFLICT_REASON,
        pin: { platform: 'ios', device: 'iPad Pro' },
        pinSource: 'project config file /repo/agent-device.json',
        conflicts: [{ key: 'device', pinned: 'iPad Pro', requested: 'iPhone 16' }],
        hint: 'This project pins platform "ios", device "iPad Pro" (project config file /repo/agent-device.json). Drop the conflicting selector to use the pinned device, or set "devicePin": false in that config.',
      });
      return true;
    },
  );
});

test('every batch step is held to the pin, and the error names the first conflicting step', () => {
  assert.throws(
    () =>
      assertRequestHonorsDevicePin(pin, {
        flags: {
          platform: 'ios',
          batchSteps: [{ flags: {} }, { flags: { platform: 'android', device: 'Pixel 8' } }],
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'details' in error);
      assert.match(
        error.message,
        /^Batch step 2: platform "android" conflicts with the device pin/,
      );
      assert.deepEqual((error.details as { conflicts: unknown }).conflicts, [
        { key: 'platform', pinned: 'ios', requested: 'android', step: 2 },
        { key: 'device', pinned: 'iPad Pro', requested: 'Pixel 8', step: 2 },
      ]);
      return true;
    },
  );
});

test('the conflict tells the user how to lift the pin for the layer that set it', () => {
  const remedies = [
    [{ kind: 'flag', label: 'the --device-pin flag' }, 'Drop --device-pin', 'drop --device-pin'],
    [
      {
        kind: 'env',
        label: 'environment variable AGENT_DEVICE_DEVICE_PIN',
        envName: 'AGENT_DEVICE_DEVICE_PIN',
      },
      'Set AGENT_DEVICE_DEVICE_PIN=0',
      'set AGENT_DEVICE_DEVICE_PIN=0',
    ],
    [
      { kind: 'explicit', label: 'config file /tmp/pin.json' },
      'Set "devicePin": false in that config',
      'set "devicePin": false in that config',
    ],
  ] as const;
  for (const [policySource, message, hint] of remedies) {
    assert.throws(
      () =>
        assertRequestHonorsDevicePin({ ...pin, policySource }, { flags: { device: 'iPhone 16' } }),
      (error: unknown) => {
        assert.ok(failsWithReason(DEVICE_PIN_CONFLICT_REASON)(error));
        assert.ok(error instanceof Error && 'details' in error);
        assert.ok(error.message.endsWith(`. ${message} to target another device.`), error.message);
        assert.ok(
          (error.details as { hint: string }).hint.endsWith(
            `Drop the conflicting selector to use the pinned device, or ${hint}.`,
          ),
        );
        return true;
      },
    );
  }
});

test('a request that repeats, refines, or omits the pin passes', () => {
  assertRequestHonorsDevicePin(pin, {});
  assertRequestHonorsDevicePin(pin, { flags: { platform: 'ios', device: ' iPad Pro ' } });
  // A UDID picks one device among several that share the pinned name; selection has to satisfy both.
  assertRequestHonorsDevicePin(pin, {
    flags: { udid: 'ABCDEF', batchSteps: [{ flags: { serial: 'R5CT1234ABC' } }, {}] },
  });
});
