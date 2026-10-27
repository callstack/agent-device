import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerTestHost } from '../test-host.ts';
import { hasCachedAppleRunnerArtifact } from '../runner-xctestrun.ts';

beforeEach(() => {
  appleRunnerTestHost.update({});
});

const simulator: DeviceInfo = {
  platform: 'apple',
  id: 'cache-probe-sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

let derivedDir: string;

beforeEach(() => {
  derivedDir = mkdtempForTestSync('agent-device-cache-probe-');
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derivedDir;
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  fs.rmSync(derivedDir, { recursive: true, force: true });
});

test('probe reports no cache for an empty derived directory', async () => {
  expect(await hasCachedAppleRunnerArtifact(simulator)).toBe(false);
});

test('probe rejects a partial cache holding only a stray xctestrun file', async () => {
  // Regression: the probe used to treat any .xctestrun file as a usable
  // cache, while the ensure path rejects it (no cache metadata, no product
  // validation) and rebuilds — making doctor skip a warmup the first open
  // still had to pay for.
  const productsDir = path.join(derivedDir, 'Build', 'Products');
  fs.mkdirSync(productsDir, { recursive: true });
  fs.writeFileSync(
    path.join(
      productsDir,
      'AgentDeviceRunner_AgentDeviceRunnerUITests_iphonesimulator26.2-arm64.xctestrun',
    ),
    'not a real xctestrun plist',
    'utf8',
  );

  expect(await hasCachedAppleRunnerArtifact(simulator)).toBe(false);
});
