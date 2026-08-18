// Routed-lane witnesses (#1781 A9-2): the live ios.yml agrees with the selector, and each
// planted disagreement below is reported — an ignore that hides an Apple path or a tooling
// glob, and a missing ignore for a tree the selector says is another family's.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ROUTED_LANES } from './declarations.ts';
import { loadModel, type Model } from './model.ts';
import { routing } from './routing.ts';
import type { Lane } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);
const IOS = ROUTED_LANES.find((routed) => routed.lane === 'iOS / Smoke Tests');
assert.ok(IOS, 'the iOS lane is declared routed');
const iosLane = base.lanes.find((lane) => lane.label === IOS.lane);
assert.ok(iosLane, 'ios.yml defines the routed lane');

function withIos(change: (lane: Lane) => Lane): Model {
  return {
    ...base,
    lanes: base.lanes.map((lane) => (lane.label === IOS.lane ? change(lane) : lane)),
  };
}

const messages = (model: Model) => routing(model, ROUTED_LANES).map((failure) => failure.message);

test('the live ios.yml paths-ignore agrees with the selector over every tracked path', () => {
  assert.deepEqual(messages(base), []);
});

test('the routed lane derives its needs from its declared gate plus the sampled checks', () => {
  assert.ok(iosLane.gates.includes('swift-runner-ios'), 'ios.yml still declares the runner build');
  assert.deepEqual([...IOS.sampled], ['replay-ios', 'replay-ios-device']);
});

test('ignoring an Apple-owned tree is reported with the checks the selector routes it to', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: [...lane.pathsIgnore, 'src/platforms/apple/**'],
  }));
  const found = messages(model);
  assert.ok(found.length > 0);
  assert.ok(
    found.some(
      (message) =>
        /ignores src\/platforms\/apple\//.test(message) &&
        /routes it to "replay-ios"/.test(message),
    ),
    found.slice(0, 3).join('\n'),
  );
});

test('ignoring a tooling glob is reported as fail-open, even under .github/', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: [...lane.pathsIgnore, '.github/actions/**', 'package.json'],
  }));
  const found = messages(model);
  assert.ok(
    found.some(
      (message) =>
        /ignores \.github\/actions\/setup-apple-runner-build\/action\.yml/.test(message) &&
        /fails open on it \(workflow-tooling\)/.test(message),
    ),
    found.slice(0, 3).join('\n'),
  );
  assert.ok(
    found.some((message) => /ignores package\.json, but the selector fails open/.test(message)),
  );
});

test('a .github path ignored by exact name stays the workflow’s own call', () => {
  // The live list names deploy.yml and the docs preview workflows explicitly; the live tree
  // is green above, so this only pins that the exemption is by exact path, not by prefix.
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: [...lane.pathsIgnore, '.github/workflows/size.yml'],
  }));
  assert.deepEqual(messages(model), []);
});

test('dropping a family root from the ignore list fails the routing claim for that tree', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: lane.pathsIgnore.filter((pattern) => pattern !== 'src/platforms/android/**'),
  }));
  const found = messages(model);
  assert.ok(
    found.some(
      (message) =>
        /starts on src\/platforms\/android\//.test(message) &&
        /android-owned \(lanes: replay-android\)/.test(message),
    ),
    found.slice(0, 3).join('\n'),
  );
});

test('dropping the unit-test ignore fails the routing claim for a unit test', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: lane.pathsIgnore.filter((pattern) => pattern !== 'src/**/*.test.ts'),
  }));
  assert.ok(
    messages(model).some((message) =>
      /\.test\.ts, which the selector classifies as a unit test/.test(message),
    ),
  );
});

test('a routed lane that loses its pull_request trigger, or its job, is reported', () => {
  const gone = { ...base, lanes: base.lanes.filter((lane) => lane.label !== IOS.lane) };
  assert.ok(messages(gone).some((message) => /not defined by any workflow/.test(message)));
  const pushOnly = withIos((lane) => ({ ...lane, triggers: ['push'] }));
  assert.ok(messages(pushOnly).some((message) => /no pull_request trigger/.test(message)));
});
