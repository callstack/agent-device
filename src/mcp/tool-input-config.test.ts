import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveMcpConfigDefaults } from './tool-input-config.ts';

const supported = { platform: { type: 'string' }, device: { type: 'string' } } as const;

function hostPinnedTo(config: Record<string, unknown>) {
  const home = mkdtempForTestSync('agent-device-mcp-pin-');
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'agent-device.json'), JSON.stringify(config));
  return { cwd, env: { HOME: home, USERPROFILE: home, AGENT_DEVICE_HOME: home } };
}

// #2161: the pin is operator policy, like the session lock. A model that names another device in a
// tool call must fail with the same typed reason the CLI raises, never retarget the pinned project.
test('a tool call naming a device the project pins against fails with the typed reason', () => {
  const host = hostPinnedTo({ platform: 'ios', device: 'iPad Pro', devicePin: true });

  assert.throws(
    () => resolveMcpConfigDefaults('open', { device: 'iPhone 16' }, supported, host),
    (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'details' in error);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(
        error.message,
        /^device "iPhone 16" conflicts with the device pin from project config file/,
      );
      assert.equal((error.details as { reason?: string }).reason, 'device_pin_conflict');
      return true;
    },
  );
});

test('a tool call without a selector inherits the pinned device', () => {
  const host = hostPinnedTo({ platform: 'ios', device: 'iPad Pro', devicePin: true });
  const resolved = resolveMcpConfigDefaults('open', { target: 'com.example.app' }, supported, host);

  assert.equal(resolved.input.platform, 'ios');
  assert.equal(resolved.input.device, 'iPad Pro');
  assert.equal('devicePin' in resolved.input, false);
});

test('without devicePin the configured device stays an overridable default for tool input', () => {
  const host = hostPinnedTo({ platform: 'ios', device: 'iPad Pro' });
  const resolved = resolveMcpConfigDefaults('open', { device: 'iPhone 16' }, supported, host);

  assert.equal(resolved.input.device, 'iPhone 16');
});
