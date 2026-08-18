import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { commandDescriptors, resolveCommandDeviceClaimPolicy } from '../registry.ts';
import type { DeviceClaimPolicy } from '../types.ts';

// #1320 completeness gate. TypeScript already makes the trait required on every
// raw descriptor, so these tests only pin what types cannot: the CLASSIFICATION,
// and the structural precondition that makes it enforceable.

function commandsByPolicy(): Partial<Record<DeviceClaimPolicy, string[]>> {
  const grouped: Partial<Record<DeviceClaimPolicy, string[]>> = {};
  for (const descriptor of commandDescriptors) {
    (grouped[descriptor.deviceClaimPolicy] ??= []).push(descriptor.name);
  }
  for (const names of Object.values(grouped)) names.sort();
  return grouped;
}

test('every public command resolves the policy its descriptor declares', () => {
  const byName = new Map(commandDescriptors.map((descriptor) => [descriptor.name, descriptor]));
  for (const command of Object.values(PUBLIC_COMMANDS)) {
    const descriptor = byName.get(command);
    assert.ok(descriptor, `public command ${command} is missing from the descriptor registry`);
    assert.equal(resolveCommandDeviceClaimPolicy(command), descriptor.deviceClaimPolicy);
  }
  // Command names outside the registry stay claim-free rather than fail closed
  // into an acquisition no owner would ever release.
  assert.equal(resolveCommandDeviceClaimPolicy(undefined), 'require-owner');
  assert.equal(resolveCommandDeviceClaimPolicy('not-a-registered-command'), 'require-owner');
});

test('every command that deviates from require-owner is a reviewed, diffable set', () => {
  // CONSERVATIVE: these lists may only change in the same PR that updates them
  // here. A `transient-exclusive` command takes host-global exclusive ownership
  // of its device for one request, so adding one changes cross-worktree
  // behavior for everyone sharing that device (#1799); `none` is for
  // host/config-only commands and pure delegators, whose device work runs inside
  // the request scope of the command they dispatch.
  const { 'require-owner': _sessionBound, ...deviating } = commandsByPolicy();
  assert.deepEqual(deviating, {
    'acquire-session': ['open'],
    'release-session': ['close'],
    'transient-exclusive': [
      'boot',
      'install',
      'install_source',
      'prepare',
      'push',
      'reinstall',
      'shutdown',
    ],
    observe: ['apps', 'appstate', 'capabilities', 'device', 'devices', 'doctor'],
    none: [
      'artifacts',
      'auth',
      'batch',
      'cdp',
      'connect',
      'connection',
      'daemon',
      'debug',
      'disconnect',
      'install-from-source',
      'lease_allocate',
      'lease_heartbeat',
      'lease_release',
      'mcp',
      'metro',
      'proxy',
      'react-devtools',
      'release_materialized_paths',
      'session',
      'session_list',
      'session_save_script',
      'web',
    ],
  });
});

test('a transient-exclusive command can actually reach the device binding seam', () => {
  // The claim gate lives on the request scope's device binding, which only ADR
  // 0019 `device-runtime` commands pass through: an unmigrated (`legacy`)
  // command reaches its device through dispatch instead, so declaring
  // `transient-exclusive` there would be a claim nobody ever acquires. Live
  // verification of #1799 caught exactly that on `keyboard`. Those commands stay
  // `require-owner` until their platform execution migrates.
  for (const descriptor of commandDescriptors) {
    if (descriptor.deviceClaimPolicy !== 'transient-exclusive') continue;
    assert.ok(descriptor.daemon, `${descriptor.name}: transient-exclusive without a daemon route`);
    assert.equal(
      descriptor.platformExecution.kind,
      'device-runtime',
      `${descriptor.name}: transient-exclusive cannot be enforced without device-runtime execution`,
    );
  }
});
