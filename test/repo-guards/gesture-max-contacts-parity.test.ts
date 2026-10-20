import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { GESTURE_MAX_CONTACTS } from '@agent-device/contracts/gesture-plan-types';

// The tap contact cap is one fact in three languages: the planner refuses more contacts, and the
// iOS runner and Android helper each refuse a plan that carries more. No runtime shares the
// values, so this guard reads both literals from source and fails if either drifts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SWIFT_MODELS = path.join(
  ROOT,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift',
);
const JAVA_TOUCH_PLAN = path.join(
  ROOT,
  'android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/TouchPlan.java',
);

test('the iOS runner and Android helper cap tap contacts at the planner limit', () => {
  const swift = readLiteral(SWIFT_MODELS, /^let runnerGestureMaxContacts = (\d+)$/m);
  const java = readLiteral(JAVA_TOUCH_PLAN, /static final int MAX_CONTACTS = (\d+);/);

  assert.equal(swift, GESTURE_MAX_CONTACTS);
  assert.equal(java, GESTURE_MAX_CONTACTS);
});

function readLiteral(file: string, pattern: RegExp): number {
  const match = pattern.exec(fs.readFileSync(file, 'utf8'));
  assert.ok(match, `${path.basename(file)} no longer declares the contact cap`);
  return Number(match[1]);
}
