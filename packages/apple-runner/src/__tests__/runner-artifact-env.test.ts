import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import {
  buildRunnerSessionXctestrunPathCleanupPattern,
  buildRunnerSessionXctestrunSuffix,
} from '../runner-artifact-env.ts';

// Released daemons and clients pkill runner launches by these exact bytes, and the timeout client
// pins its own copy rather than deriving it, so it survives a rename here. Each expectation below
// is a literal on purpose: deriving it from this same module would survive any rename, which is
// precisely the change these lines exist to catch.

const OWNED_ARTIFACT_PATH =
  '/derived/Build/Products/AgentDeviceRunner.env.session-SIM-001-owner-4242-ab12cd34-8123.xctestrun';

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

test('the lease cleanup pattern keeps the bytes released daemons pkilled', () => {
  const owned = buildRunnerSessionXctestrunPathCleanupPattern(OWNED_ARTIFACT_PATH);

  assert.equal(
    owned,
    String.raw`AgentDeviceRunner\.env\.session-SIM-001-owner-4242-ab12cd34-8123\.xctestrun`,
  );
  assert.equal(new RegExp(owned ?? '').test(argvFor(path.basename(OWNED_ARTIFACT_PATH))), true);
  assert.equal(
    new RegExp(owned ?? '').test(argvFor(sessionFileName('SIM-002', 'owner-4242-ab12cd34'))),
    false,
    'another device must not match',
  );
  assert.equal(
    new RegExp(owned ?? '').test(argvFor(sessionFileName('SIM-001', 'owner-9999-ffee00'))),
    false,
    'another owner must not match',
  );
  assert.equal(
    new RegExp(owned ?? '').test(
      argvFor('AgentDeviceRunner.env.session-SIM-001-owner-4242-ab12cd34-8124.xctestrun'),
    ),
    false,
    'the same session on another port must not match',
  );
});

test('a flattened name field stays selectable', () => {
  // A device id is caller-supplied and the writer flattens it onto disk; the recorded path already
  // holds the bytes the launch carries.
  const suffix = buildRunnerSessionXctestrunSuffix({
    deviceId: 'SIM 01/x',
    ownerToken: 'owner 7',
    port: 80,
  });

  assert.equal(suffix, 'session-SIM_01_x-owner_7-80');
  const flattenedPath = `/derived/Build/Products/AgentDeviceRunner.env.${suffix}.xctestrun`;
  assert.equal(
    new RegExp(buildRunnerSessionXctestrunPathCleanupPattern(flattenedPath) ?? '').test(
      argvFor(`AgentDeviceRunner.env.${suffix}.xctestrun`),
    ),
    true,
  );
});

test('a detached lease still selects the launch it started', () => {
  // Detaching rewrites `ownerToken` to `detached-<token>` while the launch keeps running under the
  // name the writer gave it. The bytes a token-derived pattern would have carried are spelled here
  // literally: they select a file that never existed, which is the gap following the recorded path
  // closes.
  const detachedTokenPattern = String.raw`AgentDeviceRunner\.env\.session-SIM-001-detached-owner-4242-ab12cd34-`;
  const argv = argvFor(path.basename(OWNED_ARTIFACT_PATH));

  assert.equal(new RegExp(detachedTokenPattern).test(argv), false);
  assert.equal(
    new RegExp(buildRunnerSessionXctestrunPathCleanupPattern(OWNED_ARTIFACT_PATH) ?? '').test(argv),
    true,
  );
});

test('a lease artifact path outside the runner session name declines to a pattern', () => {
  // A basename like `runner.xctestrun` would escape into a pattern loose enough to signal unrelated
  // xcodebuilds, so no launch is selected by it.
  assert.equal(buildRunnerSessionXctestrunPathCleanupPattern('/tmp/runner.xctestrun'), undefined);
  assert.equal(buildRunnerSessionXctestrunPathCleanupPattern(''), undefined);
});

function sessionFileName(deviceId: string, ownerToken: string): string {
  return `AgentDeviceRunner.env.${buildRunnerSessionXctestrunSuffix({ deviceId, ownerToken, port: 8123 })}.xctestrun`;
}

function argvFor(fileName: string): string {
  return `xcodebuild test-without-building -xctestrun /derived/Build/Products/${fileName}`;
}
