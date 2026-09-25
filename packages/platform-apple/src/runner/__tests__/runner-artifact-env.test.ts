import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildRunnerSessionXctestrunCleanupPattern,
  buildRunnerSessionXctestrunSuffix,
} from '../runner-artifact-env.ts';

// Released daemons and clients pkill runner launches by these exact bytes, and the timeout client
// pins its own copy rather than deriving it, so it survives a rename here. Each expectation below
// is a literal on purpose: deriving it from this same module would survive any rename, which is
// precisely the change these lines exist to catch.

test('the session suffix keeps the bytes and field order the matchers rely on', () => {
  assert.equal(
    buildRunnerSessionXctestrunSuffix({
      deviceId: 'SIM-001',
      ownerToken: 'owner-4242-ab12cd34',
      port: 8123,
    }),
    'session-SIM-001-owner-4242-ab12cd34-8123',
  );
});

test('the owner cleanup pattern keeps the bytes released daemons pkilled', () => {
  const owned = buildRunnerSessionXctestrunCleanupPattern({
    deviceId: 'SIM-001',
    ownerToken: 'owner-4242-ab12cd34',
  });

  assert.equal(owned, String.raw`AgentDeviceRunner\.env\.session-SIM-001-owner-4242-ab12cd34-`);
  assert.equal(
    new RegExp(owned).test(argvFor(sessionFileName('SIM-001', 'owner-4242-ab12cd34'))),
    true,
  );
  assert.equal(
    new RegExp(owned).test(argvFor(sessionFileName('SIM-002', 'owner-4242-ab12cd34'))),
    false,
    'another device must not match',
  );
  assert.equal(
    new RegExp(owned).test(argvFor(sessionFileName('SIM-001', 'owner-9999-ffee00'))),
    false,
    'another owner must not match',
  );
});

test('a tokenless cleanup pattern keeps selecting the pre-owner-token name and only that', () => {
  // A reclaiming daemon with no lease to read knows the device but not the owner, so it sweeps by
  // device. The released bytes require a digit right after the device, which is the pre-owner-token
  // spelling; an owner-token name needs its token to be selected.
  const tokenless = buildRunnerSessionXctestrunCleanupPattern({ deviceId: 'SIM-002' });

  assert.equal(tokenless, String.raw`AgentDeviceRunner\.env\.session-SIM-002-[0-9]`);
  assert.equal(
    new RegExp(tokenless).test(argvFor('AgentDeviceRunner.env.session-SIM-002-8123.xctestrun')),
    true,
  );
  assert.equal(
    new RegExp(tokenless).test(argvFor(sessionFileName('SIM-002', 'owner-1-ff'))),
    false,
  );
});

test('a name field is sanitized the way the filesystem writer sanitizes it', () => {
  // A device id is caller-supplied and the writer flattens it onto disk, so the matcher has to
  // flatten it too or it selects a name the launch never had.
  const suffix = buildRunnerSessionXctestrunSuffix({
    deviceId: 'SIM 01/x',
    ownerToken: 'owner 7',
    port: 80,
  });

  assert.equal(suffix, 'session-SIM_01_x-owner_7-80');
  assert.equal(
    new RegExp(
      buildRunnerSessionXctestrunCleanupPattern({ deviceId: 'SIM 01/x', ownerToken: 'owner 7' }),
    ).test(argvFor(`AgentDeviceRunner.env.${suffix}.xctestrun`)),
    true,
  );
});

function sessionFileName(deviceId: string, ownerToken: string): string {
  return `AgentDeviceRunner.env.${buildRunnerSessionXctestrunSuffix({ deviceId, ownerToken, port: 8123 })}.xctestrun`;
}

function argvFor(fileName: string): string {
  return `xcodebuild test-without-building -xctestrun /derived/Build/Products/${fileName}`;
}
