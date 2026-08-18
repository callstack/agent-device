import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildReplayTestSourceDiscovery } from '../session-test-source-discovery.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import {
  maestroScriptSourceBundleFor,
  replayScriptSourceBundleFor,
} from '../../../__tests__/test-utils/replay-script-source.ts';

// #1478 P3b: the daemon adapter's inspection capability. #1802 moved expansion and file reading
// to the caller, so what is left here is exactly format routing plus per-engine manifest
// inspection over the script sources the request carried — traversal order is pinned beside the
// caller-side discovery, scheduler filtering policy in the replay-test package.
async function inspect(files: string[], replayBackend?: string) {
  const bundles = await Promise.all(
    files.map(async (filePath) =>
      replayBackend === 'maestro'
        ? await maestroScriptSourceBundleFor(filePath)
        : replayScriptSourceBundleFor(filePath),
    ),
  );
  return buildReplayTestSourceDiscovery(bundles, replayBackend)();
}

test('replay-test source inspection tags a Maestro flow caller-bound and carries its name', async () => {
  const root = mkdtempForTestSync('agent-device-test-inspect-maestro-');
  const flowPath = path.join(root, '01-flow.yaml');
  fs.writeFileSync(flowPath, 'appId: demo\nname: Bottom Tabs - Dynamic\n---\n- launchApp\n');

  const [entry] = await inspect([flowPath], 'maestro');

  assert.equal(entry?.path, flowPath);
  assert.equal(entry?.manifest.device.platform.kind, 'caller-bound');
  assert.equal(entry?.manifest.title, 'Bottom Tabs - Dynamic');
});

test('replay-test source inspection leaves a native .ad without metadata unspecified', async () => {
  const root = mkdtempForTestSync('agent-device-test-inspect-native-');
  const scriptPath = path.join(root, '03-flow.ad');
  fs.writeFileSync(scriptPath, 'open "Demo"\n');

  // Maestro mode routes by extension: a native source in a Maestro suite is still native, so it
  // declares no platform rather than inheriting the invocation's.
  const [entry] = await inspect([scriptPath], 'maestro');

  assert.equal(entry?.manifest.device.platform.kind, 'unspecified');
  assert.equal(entry?.manifest.title, undefined);
});

test('replay-test source inspection reads declared platform, target and attempt defaults', async () => {
  const root = mkdtempForTestSync('agent-device-test-inspect-metadata-');
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(
    scriptPath,
    ['context platform=ios target=mobile timeout=4000 retries=2', 'open "Demo"', ''].join('\n'),
  );

  const [entry] = await inspect([scriptPath]);

  assert.deepEqual(entry?.manifest.device, {
    platform: { kind: 'declared', value: 'ios' },
    target: 'mobile',
  });
  assert.deepEqual(entry?.manifest.attemptDefaults, { timeoutMs: 4000, retries: 2 });
});

test('replay-test source inspection keeps the order the caller discovered', async () => {
  const root = mkdtempForTestSync('agent-device-test-inspect-order-');
  const second = path.join(root, '02-second.ad');
  const first = path.join(root, '01-first.ad');
  fs.writeFileSync(first, 'open "First"\n');
  fs.writeFileSync(second, 'open "Second"\n');

  assert.deepEqual(
    (await inspect([second, first])).map((entry) => path.basename(entry.path)),
    ['02-second.ad', '01-first.ad'],
  );
});
