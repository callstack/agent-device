import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// The full-screen rule is one fact in two native targets: the Simulator snapshot bridge refuses a
// capture whose app window does not fill the screen, and the iOS runner refuses to route a
// window-less gesture onto a screen it cannot prove the app fills. The two binaries build from
// disjoint source roots whose packaged layouts differ, so no include path reaches both builds.
// Each source therefore carries the rule between the sentinels below, and this guard fails the
// moment the two copies stop being byte-identical — the pinned-equal form of one implementation.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER_BRIDGE = path.join(
  ROOT,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerXCTestEventBridge.m',
);
const SNAPSHOT_RUNTIME = path.join(ROOT, 'apple/snapshot-bridge/SnapshotBridgeRuntime.m');
const BEGIN = '// AGENT_DEVICE_FULL_SCREEN_RULE_BEGIN';
const END = '// AGENT_DEVICE_FULL_SCREEN_RULE_END';

test('both native targets carry the byte-identical full-screen rule block', () => {
  const runner = ruleBlock(RUNNER_BRIDGE);
  const snapshot = ruleBlock(SNAPSHOT_RUNTIME);
  assert.equal(
    runner,
    snapshot,
    'The full-screen rule drifted apart; edit one copy and re-run this guard, or move the rule ' +
      'to a header both builds can include.',
  );
});

function ruleBlock(file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(begin >= 0 && end > begin, `${path.basename(file)} no longer marks its rule block`);
  return text.slice(begin, end + END.length);
}
